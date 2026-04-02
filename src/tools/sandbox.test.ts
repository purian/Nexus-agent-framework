import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { DockerSandbox } from "./sandbox.js";
import type { SandboxConfig, ToolContext, PermissionContext, NexusConfig } from "../types/index.js";
import { bashTool } from "./bash.js";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

interface MockProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function createMockProcess(exitCode = 0): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  // Auto-close after a tick unless test controls it
  proc._autoClose = true;
  proc._exitCode = exitCode;
  return proc;
}

// We need to extend MockProcess for internal tracking
declare module "node:events" {
  interface EventEmitter {
    _autoClose?: boolean;
    _exitCode?: number;
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Import the mocked spawn
import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    ...overrides,
  };
}

function makePermissions(): PermissionContext {
  return {
    mode: "allowAll",
    rules: [],
    checkPermission() {
      return { behavior: "allow" as const };
    },
    addRule() {},
    removeRule() {},
  };
}

function makeNexusConfig(tempDir: string, sandbox?: SandboxConfig): NexusConfig {
  return {
    defaultModel: "test",
    defaultProvider: "test",
    workingDirectory: tempDir,
    dataDirectory: tempDir,
    permissionMode: "allowAll",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 4,
    thinking: { enabled: false },
    sandbox,
  };
}

function makeToolContext(tempDir: string, sandbox?: SandboxConfig): ToolContext {
  return {
    workingDirectory: tempDir,
    abortSignal: new AbortController().signal,
    permissions: makePermissions(),
    config: makeNexusConfig(tempDir, sandbox),
  };
}

// ---------------------------------------------------------------------------
// Tests — buildDockerArgs
// ---------------------------------------------------------------------------

describe("DockerSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildDockerArgs", () => {
    it("generates correct basic docker run args", () => {
      const sandbox = new DockerSandbox(makeConfig());
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      expect(args).toContain("run");
      expect(args).toContain("--rm");
      expect(args).toContain("bash");
      expect(args).toContain("-c");
      expect(args).toContain("echo hello");
      expect(args).toContain("node:20-slim");
    });

    it("includes --memory flag when memoryLimit is set", () => {
      const sandbox = new DockerSandbox(makeConfig({ memoryLimit: "512m" }));
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      const memIdx = args.indexOf("--memory");
      expect(memIdx).toBeGreaterThan(-1);
      expect(args[memIdx + 1]).toBe("512m");
    });

    it("includes --cpus flag when cpuLimit is set", () => {
      const sandbox = new DockerSandbox(makeConfig({ cpuLimit: "1.5" }));
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      const cpuIdx = args.indexOf("--cpus");
      expect(cpuIdx).toBeGreaterThan(-1);
      expect(args[cpuIdx + 1]).toBe("1.5");
    });

    it("uses network none by default", () => {
      const sandbox = new DockerSandbox(makeConfig());
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      const netIdx = args.indexOf("--network");
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe("none");
    });

    it("uses network bridge when configured", () => {
      const sandbox = new DockerSandbox(makeConfig({ networkMode: "bridge" }));
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      const netIdx = args.indexOf("--network");
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe("bridge");
    });

    it("includes read-only mounts with :ro suffix", () => {
      const sandbox = new DockerSandbox(
        makeConfig({ readOnlyMounts: ["/etc/config", "/opt/data"] }),
      );
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      expect(args).toContain("/etc/config:/etc/config:ro");
      expect(args).toContain("/opt/data:/opt/data:ro");
    });

    it("includes read-write mounts without :ro suffix", () => {
      const sandbox = new DockerSandbox(
        makeConfig({ readWriteMounts: ["/var/output"] }),
      );
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      expect(args).toContain("/var/output:/var/output");
    });

    it("merges config and options environment variables", () => {
      const sandbox = new DockerSandbox(
        makeConfig({ env: { FOO: "bar", SHARED: "config" } }),
      );
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
        env: { BAZ: "qux", SHARED: "options" },
      });

      expect(args).toContain("FOO=bar");
      expect(args).toContain("BAZ=qux");
      // Options env should override config env
      expect(args).toContain("SHARED=options");
      expect(args).not.toContain("SHARED=config");
    });

    it("uses custom image when configured", () => {
      const sandbox = new DockerSandbox(makeConfig({ image: "ubuntu:22.04" }));
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      expect(args).toContain("ubuntu:22.04");
      expect(args).not.toContain("node:20-slim");
    });

    it("uses node:20-slim as default image", () => {
      const sandbox = new DockerSandbox(makeConfig());
      const args = sandbox.buildDockerArgs({
        command: "echo hello",
        workingDirectory: "/tmp/work",
      });

      expect(args).toContain("node:20-slim");
    });

    it("always mounts the working directory at /workspace", () => {
      const sandbox = new DockerSandbox(makeConfig());
      const args = sandbox.buildDockerArgs({
        command: "ls",
        workingDirectory: "/home/user/project",
      });

      expect(args).toContain("/home/user/project:/workspace");
      expect(args).toContain("-w");
      expect(args).toContain("/workspace");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — execute
  // ---------------------------------------------------------------------------

  describe("execute", () => {
    it("runs command in container and returns result", async () => {
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const sandbox = new DockerSandbox(makeConfig());
      const resultPromise = sandbox.execute({
        command: "echo hello",
        workingDirectory: "/tmp/work",
        timeout: 30,
      });

      // Simulate output
      proc.stdout.emit("data", Buffer.from("hello\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["run", "--rm"]),
        expect.any(Object),
      );
    });

    it("collects stdout and stderr", async () => {
      const proc = createMockProcess(1);
      mockSpawn.mockReturnValueOnce(proc as any);

      const sandbox = new DockerSandbox(makeConfig());
      const resultPromise = sandbox.execute({
        command: "failing-cmd",
        workingDirectory: "/tmp/work",
        timeout: 30,
      });

      proc.stdout.emit("data", Buffer.from("out1"));
      proc.stdout.emit("data", Buffer.from("out2"));
      proc.stderr.emit("data", Buffer.from("err1"));
      proc.stderr.emit("data", Buffer.from("err2"));
      proc.emit("close", 1);

      const result = await resultPromise;
      expect(result.stdout).toBe("out1out2");
      expect(result.stderr).toBe("err1err2");
      expect(result.exitCode).toBe(1);
    });

    it("handles timeout by killing container", async () => {
      const proc = createMockProcess(0);
      // First call: docker run; Second call: docker kill
      const killProc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any).mockReturnValueOnce(killProc as any);

      const sandbox = new DockerSandbox(makeConfig());
      const resultPromise = sandbox.execute({
        command: "sleep 999",
        workingDirectory: "/tmp/work",
        timeout: 0.01, // Very short timeout
      });

      // Wait for timeout to fire, then close process
      await new Promise((r) => setTimeout(r, 50));
      proc.emit("close", 137);

      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toContain("timed out");
      // docker kill should have been called
      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        ["kill", expect.stringContaining("nexus-sandbox-")],
        expect.any(Object),
      );
    });

    it("handles abort signal", async () => {
      const proc = createMockProcess(0);
      const killProc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any).mockReturnValueOnce(killProc as any);

      const controller = new AbortController();
      const sandbox = new DockerSandbox(makeConfig());
      const resultPromise = sandbox.execute({
        command: "sleep 999",
        workingDirectory: "/tmp/work",
        timeout: 300,
        abortSignal: controller.signal,
      });

      // Abort after a tick
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));
      proc.emit("close", 137);

      const result = await resultPromise;
      // docker kill should have been called
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("handles already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const sandbox = new DockerSandbox(makeConfig());
      const result = await sandbox.execute({
        command: "echo hello",
        workingDirectory: "/tmp/work",
        timeout: 30,
        abortSignal: controller.signal,
      });

      expect(result.stderr).toBe("Aborted");
      expect(result.exitCode).toBe(1);
      // Should not have spawned docker
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("tracks active containers and removes on completion", async () => {
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const sandbox = new DockerSandbox(makeConfig());

      const resultPromise = sandbox.execute({
        command: "echo hello",
        workingDirectory: "/tmp/work",
        timeout: 30,
      });

      // Container should be tracked while running
      expect(sandbox.containers.size).toBe(1);

      proc.emit("close", 0);
      await resultPromise;

      // Container should be removed after completion
      expect(sandbox.containers.size).toBe(0);
    });

    it("reports progress via onStdout and onStderr callbacks", async () => {
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const sandbox = new DockerSandbox(makeConfig());
      const resultPromise = sandbox.execute({
        command: "echo hello",
        workingDirectory: "/tmp/work",
        timeout: 30,
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      });

      proc.stdout.emit("data", Buffer.from("line1\n"));
      proc.stdout.emit("data", Buffer.from("line2\n"));
      proc.stderr.emit("data", Buffer.from("warn\n"));
      proc.emit("close", 0);

      await resultPromise;

      expect(stdoutChunks).toEqual(["line1\n", "line2\n"]);
      expect(stderrChunks).toEqual(["warn\n"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — isAvailable
  // ---------------------------------------------------------------------------

  describe("isAvailable", () => {
    it("returns true when docker info exits with code 0", async () => {
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const sandbox = new DockerSandbox(makeConfig());

      const promise = sandbox.isAvailable();
      proc.emit("close", 0);

      expect(await promise).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("docker", ["info"], expect.any(Object));
    });

    it("returns false when docker is not available", async () => {
      const proc = createMockProcess(1);
      mockSpawn.mockReturnValueOnce(proc as any);

      const sandbox = new DockerSandbox(makeConfig());

      const promise = sandbox.isAvailable();
      proc.emit("error", new Error("not found"));

      expect(await promise).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — cleanup
  // ---------------------------------------------------------------------------

  describe("cleanup", () => {
    it("kills all active containers", async () => {
      // Manually add containers to the set to simulate active state
      const sandbox = new DockerSandbox(makeConfig());
      sandbox.containers.add("nexus-sandbox-aaa");
      sandbox.containers.add("nexus-sandbox-bbb");

      const killProc1 = createMockProcess(0);
      const killProc2 = createMockProcess(0);
      mockSpawn
        .mockReturnValueOnce(killProc1 as any)
        .mockReturnValueOnce(killProc2 as any);

      const cleanupPromise = sandbox.cleanup();

      // Simulate kills completing
      killProc1.emit("close", 0);
      killProc2.emit("close", 0);

      await cleanupPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        ["kill", "nexus-sandbox-aaa"],
        expect.any(Object),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        ["kill", "nexus-sandbox-bbb"],
        expect.any(Object),
      );
    });

    it("clears active container set after cleanup", async () => {
      const sandbox = new DockerSandbox(makeConfig());
      sandbox.containers.add("nexus-sandbox-ccc");

      const killProc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(killProc as any);

      const cleanupPromise = sandbox.cleanup();
      killProc.emit("close", 0);
      await cleanupPromise;

      expect(sandbox.containers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — generateContainerId
  // ---------------------------------------------------------------------------

  describe("generateContainerId", () => {
    it("produces unique IDs with nexus-sandbox prefix", () => {
      const sandbox = new DockerSandbox(makeConfig());
      const id1 = sandbox.generateContainerId();
      const id2 = sandbox.generateContainerId();

      expect(id1).toMatch(/^nexus-sandbox-[a-f0-9]{16}$/);
      expect(id2).toMatch(/^nexus-sandbox-[a-f0-9]{16}$/);
      expect(id1).not.toBe(id2);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — bash tool integration
// ---------------------------------------------------------------------------

describe("bashTool sandbox integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses sandbox when sandbox config is enabled", async () => {
    const proc = createMockProcess(0);
    mockSpawn.mockReturnValueOnce(proc as any);

    const sandboxConfig: SandboxConfig = { enabled: true };
    const ctx = makeToolContext("/tmp/work", sandboxConfig);

    const resultPromise = bashTool.execute(
      { command: "echo sandboxed", timeout: 30 },
      ctx,
    );

    proc.stdout.emit("data", Buffer.from("sandboxed\n"));
    proc.emit("close", 0);

    const result = await resultPromise;
    expect(result.data.stdout).toBe("sandboxed\n");
    expect(result.data.exitCode).toBe(0);
    // Should have called docker run
    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--rm"]),
      expect.any(Object),
    );
  });

  it("falls back to direct execution when sandbox is disabled", async () => {
    const proc = createMockProcess(0);
    mockSpawn.mockReturnValueOnce(proc as any);

    const ctx = makeToolContext("/tmp/work", undefined);

    const resultPromise = bashTool.execute(
      { command: "echo direct", timeout: 30 },
      ctx,
    );

    proc.stdout.emit("data", Buffer.from("direct\n"));
    proc.emit("close", 0);

    const result = await resultPromise;
    expect(result.data.stdout).toBe("direct\n");
    // Should have called bash directly, not docker
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "echo direct"],
      expect.any(Object),
    );
  });
});
