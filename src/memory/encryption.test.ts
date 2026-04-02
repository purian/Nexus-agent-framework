import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryEncryption } from "./encryption.js";
import { MemoryManager } from "./index.js";
import type { EncryptionConfig, MemoryType } from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

/** Generate a valid 256-bit hex key. */
function makeHexKey(): string {
  return randomBytes(32).toString("hex");
}

/** Create a unique temp directory for each test's database. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-enc-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a basic EncryptionConfig with a masterKey. */
function makeConfig(overrides?: Partial<EncryptionConfig>): EncryptionConfig {
  return {
    enabled: true,
    masterKey: makeHexKey(),
    ...overrides,
  };
}

// ============================================================================
// MemoryEncryption — constructor
// ============================================================================

describe("MemoryEncryption", () => {
  describe("constructor", () => {
    it("accepts masterKey (hex)", () => {
      const enc = new MemoryEncryption(makeConfig());
      expect(enc).toBeInstanceOf(MemoryEncryption);
    });

    it("accepts passphrase", () => {
      const enc = new MemoryEncryption(
        makeConfig({ masterKey: undefined, passphrase: "my-secret-passphrase" }),
      );
      expect(enc).toBeInstanceOf(MemoryEncryption);
    });

    it("throws when neither masterKey nor passphrase", () => {
      expect(
        () => new MemoryEncryption({ enabled: true }),
      ).toThrow("EncryptionConfig requires either masterKey or passphrase");
    });

    it("throws for invalid hex key (wrong length)", () => {
      expect(
        () => new MemoryEncryption(makeConfig({ masterKey: "abcdef" })),
      ).toThrow("Invalid masterKey: expected 64 hex characters");
    });

    it('default encrypted fields is ["content"]', () => {
      const enc = new MemoryEncryption(makeConfig());
      expect(enc.shouldEncryptField("content")).toBe(true);
      expect(enc.shouldEncryptField("name")).toBe(false);
      expect(enc.shouldEncryptField("description")).toBe(false);
      expect(enc.shouldEncryptField("tags")).toBe(false);
    });

    it("custom encrypted fields", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["name", "description", "content", "tags"] }),
      );
      expect(enc.shouldEncryptField("name")).toBe(true);
      expect(enc.shouldEncryptField("description")).toBe(true);
      expect(enc.shouldEncryptField("content")).toBe(true);
      expect(enc.shouldEncryptField("tags")).toBe(true);
    });
  });

  // ==========================================================================
  // encrypt / decrypt
  // ==========================================================================

  describe("encrypt", () => {
    it("produces enc:v1: prefixed output", () => {
      const enc = new MemoryEncryption(makeConfig());
      const result = enc.encrypt("hello world");
      expect(result.startsWith("enc:v1:")).toBe(true);
    });

    it("different calls produce different ciphertext (random IV)", () => {
      const enc = new MemoryEncryption(makeConfig());
      const a = enc.encrypt("same input");
      const b = enc.encrypt("same input");
      expect(a).not.toBe(b);
    });

    it("handles empty string", () => {
      const enc = new MemoryEncryption(makeConfig());
      const encrypted = enc.encrypt("");
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      expect(enc.decrypt(encrypted)).toBe("");
    });

    it("handles unicode content", () => {
      const enc = new MemoryEncryption(makeConfig());
      const unicode = "Hello \u{1F600} \u00E9\u00E8\u00EA \u4F60\u597D \u0410\u0411\u0412";
      const encrypted = enc.encrypt(unicode);
      expect(enc.decrypt(encrypted)).toBe(unicode);
    });
  });

  describe("decrypt", () => {
    it("decrypts encrypted value correctly", () => {
      const enc = new MemoryEncryption(makeConfig());
      const plaintext = "sensitive data here";
      const encrypted = enc.encrypt(plaintext);
      expect(enc.decrypt(encrypted)).toBe(plaintext);
    });

    it("roundtrip preserves content", () => {
      const enc = new MemoryEncryption(makeConfig());
      const original = "The quick brown fox jumps over the lazy dog. 1234567890!@#$%";
      expect(enc.decrypt(enc.encrypt(original))).toBe(original);
    });

    it("returns plaintext for non-encrypted values (legacy)", () => {
      const enc = new MemoryEncryption(makeConfig());
      const legacy = "this is plain text without enc prefix";
      expect(enc.decrypt(legacy)).toBe(legacy);
    });

    it("throws for tampered ciphertext", () => {
      const enc = new MemoryEncryption(makeConfig());
      const encrypted = enc.encrypt("secret");
      // Tamper with the base64 payload
      const parts = encrypted.split(":");
      const payload = Buffer.from(parts[2], "base64");
      // Flip a byte in the ciphertext portion (after iv + authTag)
      payload[33] ^= 0xff;
      const tampered = `enc:v1:${payload.toString("base64")}`;
      expect(() => enc.decrypt(tampered)).toThrow("Decryption failed");
    });

    it("throws for wrong key", () => {
      const enc1 = new MemoryEncryption(makeConfig({ masterKey: makeHexKey() }));
      const enc2 = new MemoryEncryption(makeConfig({ masterKey: makeHexKey() }));
      const encrypted = enc1.encrypt("secret data");
      expect(() => enc2.decrypt(encrypted)).toThrow("Decryption failed");
    });
  });

  // ==========================================================================
  // shouldEncryptField
  // ==========================================================================

  describe("shouldEncryptField", () => {
    it("returns true for configured fields", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["name", "content"] }),
      );
      expect(enc.shouldEncryptField("name")).toBe(true);
      expect(enc.shouldEncryptField("content")).toBe(true);
    });

    it("returns false for non-configured fields", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["content"] }),
      );
      expect(enc.shouldEncryptField("name")).toBe(false);
      expect(enc.shouldEncryptField("description")).toBe(false);
      expect(enc.shouldEncryptField("tags")).toBe(false);
    });
  });

  // ==========================================================================
  // encryptEntry / decryptEntry
  // ==========================================================================

  describe("encryptEntry", () => {
    it("encrypts only configured fields", () => {
      const enc = new MemoryEncryption(makeConfig({ encryptedFields: ["content"] }));
      const entry = {
        name: "my name",
        description: "my description",
        content: "secret content",
        tags: ["a", "b"],
      };

      const encrypted = enc.encryptEntry(entry);
      expect(encrypted.content.startsWith("enc:v1:")).toBe(true);
      expect(encrypted.name).toBe("my name");
      expect(encrypted.description).toBe("my description");
      expect(encrypted.tags).toEqual(["a", "b"]);
    });

    it("leaves non-configured fields as plaintext", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["name", "description"] }),
      );
      const entry = {
        name: "secret name",
        description: "secret description",
        content: "plain content",
      };

      const encrypted = enc.encryptEntry(entry);
      expect(encrypted.name.startsWith("enc:v1:")).toBe(true);
      expect(encrypted.description.startsWith("enc:v1:")).toBe(true);
      expect(encrypted.content).toBe("plain content");
    });

    it("handles tags field (JSON serialization)", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["tags"] }),
      );
      const entry = {
        name: "name",
        description: "desc",
        content: "content",
        tags: ["secret-tag-1", "secret-tag-2"],
      };

      const encrypted = enc.encryptEntry(entry);
      // Tags should be encrypted into a single-element array
      expect(encrypted.tags).toHaveLength(1);
      expect(encrypted.tags![0].startsWith("enc:v1:")).toBe(true);
    });
  });

  describe("decryptEntry", () => {
    it("decrypts only configured fields", () => {
      const enc = new MemoryEncryption(makeConfig({ encryptedFields: ["content"] }));
      const entry = {
        name: "my name",
        description: "my description",
        content: "secret content",
      };

      const encrypted = enc.encryptEntry(entry);
      const decrypted = enc.decryptEntry(encrypted);
      expect(decrypted.content).toBe("secret content");
      expect(decrypted.name).toBe("my name");
      expect(decrypted.description).toBe("my description");
    });

    it("roundtrip preserves all fields", () => {
      const enc = new MemoryEncryption(
        makeConfig({ encryptedFields: ["name", "description", "content", "tags"] }),
      );
      const entry = {
        name: "Test Name",
        description: "Test Description",
        content: "Test Content",
        tags: ["tag1", "tag2", "tag3"],
      };

      const decrypted = enc.decryptEntry(enc.encryptEntry(entry));
      expect(decrypted.name).toBe(entry.name);
      expect(decrypted.description).toBe(entry.description);
      expect(decrypted.content).toBe(entry.content);
      expect(decrypted.tags).toEqual(entry.tags);
    });
  });

  // ==========================================================================
  // deriveKey
  // ==========================================================================

  describe("deriveKey", () => {
    it("same passphrase produces same key", () => {
      const key1 = MemoryEncryption.deriveKey("my-passphrase");
      const key2 = MemoryEncryption.deriveKey("my-passphrase");
      expect(key1.equals(key2)).toBe(true);
    });

    it("different passphrases produce different keys", () => {
      const key1 = MemoryEncryption.deriveKey("passphrase-one");
      const key2 = MemoryEncryption.deriveKey("passphrase-two");
      expect(key1.equals(key2)).toBe(false);
    });
  });
});

// ============================================================================
// MemoryManager integration with encryption
// ============================================================================

describe("MemoryManager with encryption", () => {
  let tempDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = MemoryManager.createWithEncryption(tempDir, {
      enabled: true,
      passphrase: "test-passphrase-for-memory",
      encryptedFields: ["content"],
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("save and get with encryption roundtrip", async () => {
    const saved = await manager.save({
      type: "user" as MemoryType,
      name: "Secret note",
      description: "Contains sensitive info",
      content: "My password is hunter2",
      tags: ["secret"],
    });

    expect(saved.content).toBe("My password is hunter2");

    const retrieved = await manager.get(saved.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("My password is hunter2");
    expect(retrieved!.name).toBe("Secret note");
  });

  it("list with encryption decrypts all entries", async () => {
    await manager.save({
      type: "user" as MemoryType,
      name: "Entry 1",
      description: "First",
      content: "Secret content one",
    });
    await manager.save({
      type: "user" as MemoryType,
      name: "Entry 2",
      description: "Second",
      content: "Secret content two",
    });

    const entries = await manager.list();
    expect(entries.length).toBe(2);
    // Entries should be decrypted
    const contents = entries.map((e) => e.content);
    expect(contents).toContain("Secret content one");
    expect(contents).toContain("Secret content two");
  });

  it("search with encryption (in-memory matching)", async () => {
    await manager.save({
      type: "user" as MemoryType,
      name: "TypeScript tips",
      description: "TypeScript best practices",
      content: "Use strict mode and avoid any",
    });
    await manager.save({
      type: "user" as MemoryType,
      name: "Python tips",
      description: "Python best practices",
      content: "Use type hints and virtual environments",
    });

    const results = await manager.search("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("TypeScript tips");
  });

  it("update with encryption re-encrypts", async () => {
    const saved = await manager.save({
      type: "user" as MemoryType,
      name: "Updatable",
      description: "Will be updated",
      content: "Original secret",
    });

    const updated = await manager.update(saved.id, {
      content: "Updated secret",
    });

    expect(updated.content).toBe("Updated secret");

    const retrieved = await manager.get(saved.id);
    expect(retrieved!.content).toBe("Updated secret");
  });

  it("works without encryption (backward compat)", async () => {
    const plainDir = makeTempDir();
    const plainManager = MemoryManager.create(plainDir);

    try {
      const saved = await plainManager.save({
        type: "user" as MemoryType,
        name: "Plain entry",
        description: "No encryption",
        content: "Plaintext content",
      });

      const retrieved = await plainManager.get(saved.id);
      expect(retrieved!.content).toBe("Plaintext content");

      const results = await plainManager.search("Plaintext");
      expect(results.length).toBe(1);
    } finally {
      plainManager.close();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
