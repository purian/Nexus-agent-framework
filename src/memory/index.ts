import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { EncryptionConfig, MemoryEntry, MemoryStore, MemoryType } from "../types/index.js";
import { MemoryEncryption } from "./encryption.js";

/**
 * MemoryManager — SQLite-backed persistent memory store.
 *
 * Stores structured memories (user preferences, project context, feedback,
 * reference material) with full-text search across name, description, and
 * content fields.
 */
export class MemoryManager implements MemoryStore {
  private db: Database.Database;
  private encryption: MemoryEncryption | null;

  constructor(dbPath?: string, encryption?: MemoryEncryption | null) {
    const resolvedPath = dbPath ?? join(homedir(), ".nexus", "memory.db");
    mkdirSync(dirname(resolvedPath), { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.encryption = encryption ?? null;
    this.initialize();
  }

  /**
   * Factory method for creating a MemoryManager from a data directory.
   */
  static create(dataDirectory: string): MemoryManager {
    return new MemoryManager(join(dataDirectory, "memory.db"));
  }

  /**
   * Factory method for creating a MemoryManager with encryption enabled.
   */
  static createWithEncryption(
    dataDirectory: string,
    encryptionConfig: EncryptionConfig,
  ): MemoryManager {
    const enc = encryptionConfig.enabled
      ? new MemoryEncryption(encryptionConfig)
      : null;
    return new MemoryManager(join(dataDirectory, "memory.db"), enc);
  }

  // --------------------------------------------------------------------------
  // MemoryStore implementation
  // --------------------------------------------------------------------------

  async save(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<MemoryEntry> {
    const id = randomUUID();
    const now = new Date();

    // Encrypt fields before persisting, if encryption is configured.
    const finalEntry = this.encryption
      ? this.encryption.encryptEntry({
          name: entry.name,
          description: entry.description,
          content: entry.content,
          tags: entry.tags,
        })
      : { name: entry.name, description: entry.description, content: entry.content, tags: entry.tags };

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, type, name, description, content, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      entry.type,
      finalEntry.name,
      finalEntry.description,
      finalEntry.content,
      JSON.stringify(finalEntry.tags ?? []),
      now.toISOString(),
      now.toISOString(),
    );

    // Return the plaintext entry to the caller.
    return {
      id,
      type: entry.type,
      name: entry.name,
      description: entry.description,
      content: entry.content,
      tags: entry.tags,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;

    if (!row) return null;
    const entry = this.rowToEntry(row);
    return this.encryption ? this.decryptMemoryEntry(entry) : entry;
  }

  async search(query: string, type?: MemoryType): Promise<MemoryEntry[]> {
    // When encryption is enabled, FTS5 cannot search encrypted content.
    // Fall back to fetching all entries, decrypting them, and performing
    // case-insensitive substring matching in memory. This is acceptable for
    // the typical memory store size (hundreds to low thousands of entries).
    if (this.encryption) {
      return this.searchEncrypted(query, type);
    }

    // Use the FTS5 table for full-text search. The MATCH syntax requires
    // escaping double-quotes inside the query to avoid injection.
    const ftsQuery = query.replace(/"/g, '""');

    let sql: string;
    const params: unknown[] = [];

    if (type) {
      sql = `
        SELECT m.*
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ?
          AND m.type = ?
        ORDER BY fts.rank
      `;
      params.push(ftsQuery, type);
    } else {
      sql = `
        SELECT m.*
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ?
        ORDER BY fts.rank
      `;
      params.push(ftsQuery);
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async list(type?: MemoryType): Promise<MemoryEntry[]> {
    let rows: MemoryRow[];

    if (type) {
      rows = this.db
        .prepare("SELECT * FROM memories WHERE type = ? ORDER BY updated_at DESC")
        .all(type) as MemoryRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM memories ORDER BY updated_at DESC")
        .all() as MemoryRow[];
    }

    const entries = rows.map((row) => this.rowToEntry(row));
    return this.encryption
      ? entries.map((e) => this.decryptMemoryEntry(e))
      : entries;
  }

  async update(
    id: string,
    updates: Partial<MemoryEntry>,
  ): Promise<MemoryEntry> {
    // get() already decrypts, so `existing` has plaintext fields.
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const now = new Date();
    const merged = {
      type: updates.type ?? existing.type,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      content: updates.content ?? existing.content,
      tags: updates.tags ?? existing.tags,
    };

    // Re-encrypt for storage.
    const finalMerged = this.encryption
      ? this.encryption.encryptEntry({
          name: merged.name,
          description: merged.description,
          content: merged.content,
          tags: merged.tags,
        })
      : { name: merged.name, description: merged.description, content: merged.content, tags: merged.tags };

    this.db
      .prepare(
        `UPDATE memories
         SET type = ?, name = ?, description = ?, content = ?, tags = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.type,
        finalMerged.name,
        finalMerged.description,
        finalMerged.content,
        JSON.stringify(finalMerged.tags ?? []),
        now.toISOString(),
        id,
      );

    // Return plaintext to caller.
    return {
      id,
      ...merged,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  }

  async delete(id: string): Promise<void> {
    const result = this.db
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(id);

    if (result.changes === 0) {
      throw new Error(`Memory entry not found: ${id}`);
    }
  }

  /**
   * Close the database connection. Call this during graceful shutdown.
   */
  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL,
        content     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
    `);

    // FTS5 virtual table for full-text search across name, description, content.
    // content="" makes it an external-content table keyed by id.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id,
        name,
        description,
        content,
        content=memories,
        content_rowid=rowid
      );
    `);

    // Triggers to keep the FTS index in sync with the main table.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, name, description, content)
        VALUES (new.rowid, new.id, new.name, new.description, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, name, description, content)
        VALUES ('delete', old.rowid, old.id, old.name, old.description, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, name, description, content)
        VALUES ('delete', old.rowid, old.id, old.name, old.description, old.content);
        INSERT INTO memories_fts(rowid, id, name, description, content)
        VALUES (new.rowid, new.id, new.name, new.description, new.content);
      END;
    `);
  }

  /**
   * In-memory search fallback for encrypted stores. Decrypts all entries
   * and performs case-insensitive substring matching across name, description,
   * and content fields.
   */
  private async searchEncrypted(
    query: string,
    type?: MemoryType,
  ): Promise<MemoryEntry[]> {
    const all = await this.list(type); // list() already decrypts
    const lowerQuery = query.toLowerCase();

    return all.filter((entry) => {
      const haystack = [entry.name, entry.description, entry.content]
        .join(" ")
        .toLowerCase();
      return haystack.includes(lowerQuery);
    });
  }

  /**
   * Decrypt the encrypted fields of a MemoryEntry using the configured
   * MemoryEncryption instance.
   */
  private decryptMemoryEntry(entry: MemoryEntry): MemoryEntry {
    if (!this.encryption) return entry;

    const decrypted = this.encryption.decryptEntry({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      tags: entry.tags,
    });

    return {
      ...entry,
      name: decrypted.name,
      description: decrypted.description,
      content: decrypted.content,
      tags: decrypted.tags,
    };
  }

  private rowToEntry(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      type: row.type as MemoryType,
      name: row.name,
      description: row.description,
      content: row.content,
      tags: JSON.parse(row.tags),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

/** Raw row shape returned by better-sqlite3. */
interface MemoryRow {
  id: string;
  type: string;
  name: string;
  description: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
}
