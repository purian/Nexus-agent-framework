import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

import type { EncryptionConfig } from "../types/index.js";

/**
 * MemoryEncryption — AES-256-GCM encryption engine for memory entries.
 *
 * Encrypts/decrypts individual fields of memory entries at rest. Uses
 * authenticated encryption (GCM) so tampering is detected. Encrypted values
 * are prefixed with `enc:v1:` for easy identification and forward-compatible
 * versioning.
 */
export class MemoryEncryption {
  private key: Buffer;
  private encryptedFields: Set<string>;

  constructor(config: EncryptionConfig) {
    if (config.masterKey) {
      this.key = MemoryEncryption.parseHexKey(config.masterKey);
    } else if (config.passphrase) {
      this.key = MemoryEncryption.deriveKey(config.passphrase);
    } else {
      throw new Error(
        "EncryptionConfig requires either masterKey or passphrase",
      );
    }

    this.encryptedFields = new Set(config.encryptedFields ?? ["content"]);
  }

  /**
   * Encrypt a string value.
   * Returns a string in the format: `enc:v1:<base64(iv + authTag + ciphertext)>`
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag(); // 16 bytes

    // Pack: iv (16) + authTag (16) + ciphertext (variable)
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return `enc:v1:${combined.toString("base64")}`;
  }

  /**
   * Decrypt a previously encrypted value.
   * If the value does not have the `enc:v1:` prefix, it is returned as-is
   * (supports reading legacy unencrypted data).
   */
  decrypt(encrypted: string): string {
    if (!encrypted.startsWith("enc:v1:")) {
      return encrypted;
    }

    const payload = encrypted.slice("enc:v1:".length);
    const combined = Buffer.from(payload, "base64");

    if (combined.length < 32) {
      throw new Error("Invalid encrypted payload: too short");
    }

    const iv = combined.subarray(0, 16);
    const authTag = combined.subarray(16, 32);
    const ciphertext = combined.subarray(32);

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      throw new Error(
        "Decryption failed: invalid ciphertext or wrong key",
      );
    }
  }

  /**
   * Check if a field should be encrypted.
   */
  shouldEncryptField(fieldName: string): boolean {
    return this.encryptedFields.has(fieldName);
  }

  /**
   * Encrypt specified fields of a memory entry.
   * Returns a new object with encrypted fields.
   */
  encryptEntry(entry: {
    name: string;
    description: string;
    content: string;
    tags?: string[];
  }): { name: string; description: string; content: string; tags?: string[] } {
    const result = { ...entry };

    if (this.shouldEncryptField("name")) {
      result.name = this.encrypt(entry.name);
    }
    if (this.shouldEncryptField("description")) {
      result.description = this.encrypt(entry.description);
    }
    if (this.shouldEncryptField("content")) {
      result.content = this.encrypt(entry.content);
    }
    if (this.shouldEncryptField("tags") && entry.tags) {
      // Serialize tags to JSON, encrypt the JSON string, store as single-element array
      const tagsJson = JSON.stringify(entry.tags);
      result.tags = [this.encrypt(tagsJson)];
    }

    return result;
  }

  /**
   * Decrypt specified fields of a memory entry.
   * Returns a new object with decrypted fields.
   */
  decryptEntry(entry: {
    name: string;
    description: string;
    content: string;
    tags?: string[];
  }): { name: string; description: string; content: string; tags?: string[] } {
    const result = { ...entry };

    if (this.shouldEncryptField("name")) {
      result.name = this.decrypt(entry.name);
    }
    if (this.shouldEncryptField("description")) {
      result.description = this.decrypt(entry.description);
    }
    if (this.shouldEncryptField("content")) {
      result.content = this.decrypt(entry.content);
    }
    if (this.shouldEncryptField("tags") && entry.tags && entry.tags.length > 0) {
      // Tags were stored as [encryptedJsonString] — decrypt and parse
      const firstTag = entry.tags[0];
      if (firstTag.startsWith("enc:v1:")) {
        const decryptedJson = this.decrypt(firstTag);
        result.tags = JSON.parse(decryptedJson) as string[];
      }
    }

    return result;
  }

  /**
   * Derive a 256-bit key from a passphrase using scrypt.
   * Uses a static salt — acceptable because scrypt is already a slow KDF.
   */
  static deriveKey(passphrase: string): Buffer {
    return scryptSync(passphrase, "nexus-memory-salt", 32, {
      N: 16384,
      r: 8,
      p: 1,
    });
  }

  /**
   * Verify that a hex string is a valid 256-bit key and return it as a Buffer.
   */
  private static parseHexKey(hex: string): Buffer {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        "Invalid masterKey: expected 64 hex characters (256-bit key)",
      );
    }
    return Buffer.from(hex, "hex");
  }
}
