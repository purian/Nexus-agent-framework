// Quick standalone test of the claude-code backend.
// Run with: npx tsx src/test-backend.ts
//
// This bypasses Telegram entirely — sends two messages directly to the
// backend and prints the responses + metadata. Used to verify session
// continuity, auth (subscription not API), and JSON parsing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let currentSession: string | null = null;

async function runOne(prompt: string): Promise<void> {
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--model", "sonnet",
    "--max-budget-usd", "0.5",
  ];
  if (currentSession) args.push("--resume", currentSession);
  args.push(prompt);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  console.log(`\n>>> [${currentSession ? currentSession.slice(0, 8) : "new"}] ${prompt}`);
  const t0 = Date.now();
  try {
    const { stdout } = await execFileAsync("claude", args, {
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    });
    const dt = Date.now() - t0;
    const parsed = JSON.parse(stdout);
    if (typeof parsed.session_id === "string") currentSession = parsed.session_id;
    console.log(`<<< (${dt}ms, $${parsed.total_cost_usd}, model=${Object.keys(parsed.modelUsage ?? {})[0]}, session=${currentSession?.slice(0, 8)})`);
    console.log(parsed.result);
  } catch (e) {
    console.error("ERROR:", (e as Error).message);
  }
}

async function main() {
  await runOne("Reply with exactly: TEST OK 1");
  await runOne("What was your previous reply, verbatim?");
  await runOne("Run the shell command `date` and report the output.");
}

main().catch((e) => { console.error(e); process.exit(1); });
