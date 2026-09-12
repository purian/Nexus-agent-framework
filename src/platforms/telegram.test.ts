// TelegramAdapter against a local mock of the Bot API (connect() accepts `apiBase` for exactly
// this). Covers: callback_query delivery, sendMessage options + returned id, answer/edit
// endpoints, and the long-poll starvation regression (a send issued while getUpdates is held
// must not wait for it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { TelegramAdapter } from "./telegram.js";

const TOKEN = "123:TEST";
let server: http.Server;
let apiBase: string;
let updatesQueue: unknown[] = [];
const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let holdMs = 2500; // how long getUpdates is held open when the queue is empty

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b ? JSON.parse(b) : {}));
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const method = url.pathname.split("/").pop()!;
    res.setHeader("Content-Type", "application/json");
    if (method === "getMe") return res.end(JSON.stringify({ ok: true, result: { id: 1 } }));
    if (method === "getUpdates") {
      const flush = () => {
        const batch = updatesQueue; updatesQueue = [];
        res.end(JSON.stringify({ ok: true, result: batch }));
      };
      if (updatesQueue.length) return flush();
      const t = setTimeout(flush, holdMs);
      req.on("close", () => clearTimeout(t));
      return;
    }
    const body = await readBody(req);
    calls.push({ method, body });
    if (method === "sendMessage") return res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    res.end(JSON.stringify({ ok: true, result: true }));
  });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("TelegramAdapter", () => {
  it("delivers a callback_query tap through onMessage with callback metadata", async () => {
    updatesQueue.push({
      update_id: 7,
      callback_query: { id: "cq1", from: { id: 165185251 }, data: "bus:approve:mtygyp", message: { message_id: 42, chat: { id: 165185251 } } },
    });
    const tg = new TelegramAdapter();
    const got: unknown[] = [];
    tg.onMessage((m) => got.push(m));
    await tg.connect({ token: TOKEN, apiBase, pollingInterval: 10 });
    await new Promise((r) => setTimeout(r, 150));
    await tg.disconnect();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      platform: "telegram", chatId: "165185251", userId: "165185251", text: "",
      metadata: { callbackQueryId: "cq1", callbackData: "bus:approve:mtygyp", messageId: "42" },
    });
  });

  it("sendMessage forwards parse_mode + reply_markup and returns the message id; answer/edit hit their endpoints", async () => {
    calls.length = 0;
    const tg = new TelegramAdapter();
    await tg.connect({ token: TOKEN, apiBase, pollingInterval: 10 });
    const kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: "bus:approve:abc123" }]] };
    const sent = await tg.sendMessage("1", "<b>hi</b>", { parseMode: "HTML", replyMarkup: kb });
    expect(sent).toEqual({ messageId: "42" });
    await tg.answerCallbackQuery("cq1", "Approved ✅");
    await tg.editMessage("1", "42", "<b>done</b>", { parseMode: "HTML" });
    await tg.disconnect();
    const byMethod = Object.fromEntries(calls.map((c) => [c.method, c.body]));
    expect(byMethod.sendMessage).toMatchObject({ chat_id: "1", text: "<b>hi</b>", parse_mode: "HTML", reply_markup: kb });
    expect(byMethod.answerCallbackQuery).toEqual({ callback_query_id: "cq1", text: "Approved ✅" });
    expect(byMethod.editMessageText).toMatchObject({ chat_id: "1", message_id: 42, text: "<b>done</b>", parse_mode: "HTML" });
    expect(byMethod.editMessageText).not.toHaveProperty("reply_markup"); // omitted => keyboard removed
  });

  it("a send issued while getUpdates is held open does not wait for the long-poll (starvation regression)", async () => {
    holdMs = 2500;
    const tg = new TelegramAdapter();
    await tg.connect({ token: TOKEN, apiBase, pollingInterval: 10 });
    await new Promise((r) => setTimeout(r, 100)); // poll is now parked server-side
    const t0 = Date.now();
    await tg.sendMessage("1", "while polling");
    const took = Date.now() - t0;
    await tg.disconnect();
    expect(took).toBeLessThan(1500);
  });
});
