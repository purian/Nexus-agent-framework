import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SandboxConfig } from "../types/index.js";

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class DockerSandbox {
  private config: SandboxConfig;
  private activeContainers = new Set<string>();

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /**
   * Check if Docker is available on the system.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("docker", ["info"], {
        stdio: ["ignore", "ignore", "ignore"],
      });

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Execute a command inside a Docker container.
   */
  async execute(options: {
    command: string;
    workingDirectory: string;
    timeout: number;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }): Promise<SandboxExecResult> {
    // Check if already aborted before spawning
    if (options.abortSignal?.aborted) {
      return {
        stdout: "",
        stderr: "Aborted",
        exitCode: 1,
        timedOut: false,
      };
    }

    const containerId = this.generateContainerId();
    this.activeContainers.add(containerId);

    const args = this.buildDockerArgs({
      command: options.command,
      workingDirectory: options.workingDirectory,
      env: options.env,
      containerId,
    });

    const timeoutMs = options.timeout * 1000;

    return new Promise((resolve) => {
      const proc = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the container via docker kill
        const kill = spawn("docker", ["kill", containerId], {
          stdio: "ignore",
        });
        kill.on("close", () => {
          // Container killed, process should exit soon
        });
      }, timeoutMs);

      // Handle abort signal
      const onAbort = (): void => {
        const kill = spawn("docker", ["kill", containerId], {
          stdio: "ignore",
        });
        kill.on("close", () => {
          // Container killed
        });
      };

      if (options.abortSignal) {
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        options.onStdout?.(text);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        this.activeContainers.delete(containerId);
        if (options.abortSignal) {
          options.abortSignal.removeEventListener("abort", onAbort);
        }

        if (timedOut) {
          stderr += `\n[Container timed out after ${options.timeout}s and was killed]`;
        }

        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.activeContainers.delete(containerId);
        if (options.abortSignal) {
          options.abortSignal.removeEventListener("abort", onAbort);
        }
        resolve({
          stdout,
          stderr: stderr + `\n${err.message}`,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Kill all active containers (cleanup).
   */
  async cleanup(): Promise<void> {
    const kills = [...this.activeContainers].map(
      (name) =>
        new Promise<void>((resolve) => {
          const proc = spawn("docker", ["kill", name], {
            stdio: "ignore",
          });
          proc.on("close", () => resolve());
          proc.on("error", () => resolve());
        }),
    );

    await Promise.all(kills);
    this.activeContainers.clear();
  }

  /**
   * Build docker run arguments for a command.
   */
  buildDockerArgs(options: {
    command: string;
    workingDirectory: string;
    env?: Record<string, string>;
    containerId?: string;
  }): string[] {
    const args: string[] = ["run", "--rm"];

    // Container name
    if (options.containerId) {
      args.push("--name", options.containerId);
    }

    // Memory limit
    if (this.config.memoryLimit) {
      args.push("--memory", this.config.memoryLimit);
    }

    // CPU limit
    if (this.config.cpuLimit) {
      args.push("--cpus", this.config.cpuLimit);
    }

    // Network mode (default: none)
    args.push("--network", this.config.networkMode ?? "none");

    // Working directory mount (always read-write)
    args.push("-v", `${options.workingDirectory}:/workspace`);
    args.push("-w", "/workspace");

    // Read-only mounts
    if (this.config.readOnlyMounts) {
      for (const mount of this.config.readOnlyMounts) {
        args.push("-v", `${mount}:${mount}:ro`);
      }
    }

    // Read-write mounts
    if (this.config.readWriteMounts) {
      for (const mount of this.config.readWriteMounts) {
        args.push("-v", `${mount}:${mount}`);
      }
    }

    // Environment variables (merge config env and options env)
    const mergedEnv: Record<string, string> = {
      ...this.config.env,
      ...options.env,
    };
    for (const [key, value] of Object.entries(mergedEnv)) {
      args.push("-e", `${key}=${value}`);
    }

    // Image
    args.push(this.config.image ?? "node:20-slim");

    // Command
    args.push("bash", "-c", options.command);

    return args;
  }

  /**
   * Generate a unique container name.
   */
  generateContainerId(): string {
    const hex = randomBytes(8).toString("hex");
    return `nexus-sandbox-${hex}`;
  }

  /**
   * Get the set of active containers (for testing).
   */
  get containers(): Set<string> {
    return this.activeContainers;
  }
}
