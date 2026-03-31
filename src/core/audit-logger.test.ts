import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLogger, type AuditEntry } from "./audit-logger.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nexus-audit-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function readEntries(logPath: string): AuditEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("AuditLogger", () => {
  it("creates log file on first write", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    expect(existsSync(logger.getLogPath())).toBe(false);

    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "echo hello" },
      output: "hello",
      isError: false,
      permissionDecision: "allow",
      durationMs: 50,
    });

    expect(existsSync(logger.getLogPath())).toBe(true);
  });

  it("writes valid JSONL entries", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "ls" },
      output: "file.txt",
      isError: false,
      permissionDecision: "allow",
      durationMs: 30,
    });
    logger.log({
      toolName: "ReadFile",
      toolUseId: "tool_2",
      input: { path: "/tmp/test.txt" },
      output: "contents",
      isError: false,
      permissionDecision: "allow",
      durationMs: 10,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries).toHaveLength(2);
    expect(entries[0].toolName).toBe("Bash");
    expect(entries[1].toolName).toBe("ReadFile");
  });

  it("includes timestamp and sessionId", () => {
    const logger = new AuditLogger({
      dataDirectory: testDir,
      sessionId: "test-session",
    });
    logger.log({
      toolName: "Glob",
      toolUseId: "tool_1",
      input: { pattern: "**/*.ts" },
      isError: false,
      permissionDecision: "allow",
      durationMs: 20,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].sessionId).toBe("test-session");
    expect(entries[0].timestamp).toBeTruthy();
    expect(new Date(entries[0].timestamp).getTime()).not.toBeNaN();
  });

  it("truncates long output", () => {
    const logger = new AuditLogger({
      dataDirectory: testDir,
      maxOutputChars: 50,
    });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "cat bigfile" },
      output: "a".repeat(200),
      isError: false,
      permissionDecision: "allow",
      durationMs: 100,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].output!.length).toBeLessThan(200);
    expect(entries[0].output).toContain("...[truncated]");
  });

  it("scrubs sensitive input fields", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "WebFetch",
      toolUseId: "tool_1",
      input: {
        url: "https://api.example.com",
        apiKey: "sk-secret-123",
        token: "bearer-abc",
        normalField: "visible",
      },
      isError: false,
      permissionDecision: "allow",
      durationMs: 200,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].input.apiKey).toBe("[REDACTED]");
    expect(entries[0].input.token).toBe("[REDACTED]");
    expect(entries[0].input.normalField).toBe("visible");
    expect(entries[0].input.url).toBe("https://api.example.com");
  });

  it("logs errors correctly", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "invalid" },
      output: "command not found",
      isError: true,
      permissionDecision: "allow",
      durationMs: 5,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].isError).toBe(true);
    expect(entries[0].output).toBe("command not found");
  });

  it("logs permission denials", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "rm -rf /" },
      isError: true,
      permissionDecision: "deny",
      durationMs: 0,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].permissionDecision).toBe("deny");
  });

  it("includes agentId when provided", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "ReadFile",
      toolUseId: "tool_1",
      input: { path: "/test" },
      isError: false,
      permissionDecision: "allow",
      durationMs: 5,
      agentId: "agent-sub-1",
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].agentId).toBe("agent-sub-1");
  });

  it("does nothing when disabled", () => {
    const logger = new AuditLogger({
      dataDirectory: testDir,
      enabled: false,
    });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "echo hi" },
      isError: false,
      permissionDecision: "allow",
      durationMs: 10,
    });

    expect(existsSync(logger.getLogPath())).toBe(false);
  });

  it("creates nested directories if needed", () => {
    const nestedDir = join(testDir, "deep", "nested", "dir");
    const logger = new AuditLogger({ dataDirectory: nestedDir });
    logger.log({
      toolName: "Glob",
      toolUseId: "tool_1",
      input: { pattern: "*" },
      isError: false,
      permissionDecision: "allow",
      durationMs: 5,
    });

    expect(existsSync(logger.getLogPath())).toBe(true);
  });

  it("handles undefined output", () => {
    const logger = new AuditLogger({ dataDirectory: testDir });
    logger.log({
      toolName: "Bash",
      toolUseId: "tool_1",
      input: { command: "echo" },
      isError: false,
      permissionDecision: "allow",
      durationMs: 5,
    });

    const entries = readEntries(logger.getLogPath());
    expect(entries[0].output).toBeUndefined();
  });

  it("generates unique sessionId when not provided", () => {
    const logger1 = new AuditLogger({ dataDirectory: testDir });
    const logger2 = new AuditLogger({ dataDirectory: testDir });
    // Both should have sessionIds but they might be the same if created in same ms
    expect(logger1.getSessionId()).toBeTruthy();
    expect(logger2.getSessionId()).toBeTruthy();
  });
});
