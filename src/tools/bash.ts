import { z } from "zod";
import { spawn } from "node:child_process";
import type {
  Tool,
  ToolContext,
  ToolResult,
  PermissionDecision,
} from "../types/index.js";
import { DockerSandbox } from "./sandbox.js";

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Timeout in seconds (default 120)"),
});

type BashInput = z.infer<typeof inputSchema>;

interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export const bashTool: Tool<BashInput, BashOutput> = {
  name: "bash",
  description:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Use this for running CLI tools, scripts, git commands, package managers, " +
    "and any other system commands. Commands run in the working directory. " +
    "Prefer specific tools (read_file, write_file, glob, grep) over bash " +
    "equivalents when available.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return false;
  },

  isReadOnly(): boolean {
    return false;
  },

  async checkPermissions(
    input: BashInput,
    context: ToolContext,
  ): Promise<PermissionDecision> {
    if (context.permissions.mode === "allowAll") {
      return { behavior: "allow" };
    }

    const decision = context.permissions.checkPermission("bash", {
      command: input.command,
    });

    if (decision.behavior !== "ask") {
      return decision;
    }

    return {
      behavior: "ask",
      message: `Allow running shell command?\n$ ${input.command}`,
    };
  },

  async execute(input: BashInput, context: ToolContext): Promise<ToolResult<BashOutput>> {
    // Use Docker sandbox if enabled
    if (context.config.sandbox?.enabled) {
      const sandbox = new DockerSandbox(context.config.sandbox);
      const result = await sandbox.execute({
        command: input.command,
        workingDirectory: context.workingDirectory,
        timeout: input.timeout ?? 120,
        abortSignal: context.abortSignal,
        onStdout: (chunk) => context.onProgress?.({ toolUseId: "", message: chunk }),
        onStderr: (chunk) => context.onProgress?.({ toolUseId: "", message: chunk }),
      });
      return {
        data: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    }

    const timeoutMs = (input.timeout ?? 120) * 1000;

    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", input.command], {
        cwd: context.workingDirectory,
        signal: context.abortSignal,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, timeoutMs);

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        context.onProgress?.({
          toolUseId: "",
          message: text,
        });
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        context.onProgress?.({
          toolUseId: "",
          message: text,
        });
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);

        if (killed) {
          stderr += `\n[Process timed out after ${input.timeout ?? 120}s and was terminated]`;
        }

        resolve({
          data: {
            stdout,
            stderr,
            exitCode,
          },
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          data: {
            stdout,
            stderr: stderr + `\n${err.message}`,
            exitCode: 1,
          },
        });
      });
    });
  },

  renderToolUse(input: Partial<BashInput>): string {
    return `$ ${input.command ?? ""}`;
  },

  renderResult(output: BashOutput): string {
    const parts: string[] = [];
    if (output.stdout) parts.push(output.stdout);
    if (output.stderr) parts.push(`[stderr]\n${output.stderr}`);
    if (output.exitCode !== 0) parts.push(`[exit code: ${output.exitCode}]`);
    return parts.join("\n") || "(no output)";
  },
};
