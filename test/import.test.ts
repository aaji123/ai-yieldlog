import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSessions, toEntries } from "../src/import-claude-code.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const prices = {
  fetchedAt: "",
  source: "",
  models: { "a/m-5.5": { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5, cacheWrite1h: 8 } },
};

type Extra = { message?: object; usage?: object; line?: object };
const call = (id: string, time: string, { message, usage, line }: Extra = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: `2026-11-24T${time}:00.000Z`,
    cwd: "D:\\work\\shop",
    ...line,
    message: {
      id,
      model: "m-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "SECRET ANSWER" }],
      usage: { input_tokens: 0, output_tokens: 1_000_000, ...usage },
      ...message,
    },
  });

async function load(
  t: { after: (fn: () => void) => void },
  files: Record<string, string[]>,
  titles = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "yieldlog-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), lines.join("\n"));
  }
  return toEntries(await readSessions(dir), prices, { titles, now: NOW });
}

test("a call written on several lines counts once", async (t) => {
  const entries = await load(t, {
    "p/s1.jsonl": [call("a", "10:00"), call("a", "10:01"), call("a", "10:02"), call("b", "10:03")],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.at, Date.parse("2026-11-24T10:00:00Z"));
  assert.equal(entries[0]!.call!.cost.usd, 20);
});

test("the full usage wins when an early line has less", async (t) => {
  const [entry] = await load(t, {
    "p/s1.jsonl": [
      call("a", "10:00", { usage: { output_tokens: 1 }, message: { stop_reason: null } }),
      call("a", "10:00"),
    ],
  });
  assert.equal(entry!.call!.usage!.output, 1_000_000);
});

test("subagents belong to the session that started them", async (t) => {
  const entries = await load(t, {
    "p/s1.jsonl": [call("a", "10:00")],
    "p/s1/subagents/agent-x.jsonl": [call("b", "10:01", { line: { isSidechain: true, cwd: "/elsewhere" } })],
  });
  assert.deepEqual(new Set(entries.map((e) => e.outcome.id)), new Set(["claude-code:s1"]));
  assert.deepEqual(entries.map((e) => e.outcome.workflow), ["Claude Code: shop", "Claude Code: shop"]);
  assert.deepEqual(entries.map((e) => e.call!.step), [null, "subagent"]);
});

test("a call repeated in a resumed session counts once", async (t) => {
  const entries = await load(t, {
    "p/s1.jsonl": [call("a", "10:00")],
    "p/s2.jsonl": [call("a", "10:00"), call("b", "11:00")],
  });
  assert.equal(entries.length, 2);
});

test("broken lines, notices and unusable calls are skipped", async (t) => {
  const entries = await load(t, {
    "p/s1.jsonl": [
      "",
      "null",
      "[]",
      '{"type":"assistant","message":null}',
      '{"type":"assistant","message":{"usage":{}}}',
      call("n", "10:00", { message: { model: "<synthetic>" } }),
      call("t", "10:00", { line: { timestamp: "soon" } }),
      JSON.stringify({ type: "user", message: { content: "SECRET QUESTION" } }),
      call("a", "10:00"),
      call("b", "10:01").slice(0, 60),
    ],
    "stray.jsonl": [call("x", "10:00")],
    "p/empty.jsonl": [],
  });
  assert.deepEqual(entries.map((e) => e.call!.id), ["claude-code:a"]);
});

test("a call that may still be running waits for the next import", async (t) => {
  const unfinished = { message: { stop_reason: null } };
  const entries = await load(t, {
    "p/s1.jsonl": [call("old", "10:00", unfinished), call("new", "11:55", unfinished)],
  });
  assert.deepEqual(entries.map((e) => e.call!.id), ["claude-code:old"]);
});

test("cache prices and web searches are included", async (t) => {
  const [entry] = await load(t, {
    "p/s1.jsonl": [
      call("a", "10:00", {
        usage: {
          output_tokens: 0,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
          server_tool_use: { web_search_requests: 3 },
          speed: "standard",
          service_tier: "standard",
          inference_geo: "global",
          iterations: [{ type: "message" }],
        },
      }),
    ],
  });
  assert.ok(Math.abs(entry!.call!.cost.usd! - (0.2 + 8 + 0.03)) < 1e-9);
});

test("calls billed at another rate are flagged, not guessed", async (t) => {
  for (const usage of [
    { speed: "fast" },
    { service_tier: "batch" },
    { inference_geo: "us" },
    { iterations: [{ type: "message" }, { type: "advisor_message" }] },
  ]) {
    const [entry] = await load(t, { "p/s1.jsonl": [call("a", "10:00", { usage })] });
    assert.equal(entry!.call!.cost.source, "unknown", JSON.stringify(usage));
  }
});

test("importing again adds only what's new and keeps reviews", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = await load(t, { "p/s1.jsonl": [call("a", "10:00")] });
  assert.equal(store.logAll(first), 1);
  store.review("claude-code:s1", { status: "reworked", reviewMinutes: 3, reworkMinutes: 4 });

  const second = await load(t, { "p/s1.jsonl": [call("a", "10:00"), call("b", "11:00")] });
  assert.equal(store.logAll(second), 1);
  const [row] = store.list(0, NOW, null, 10);
  assert.equal(row!.calls, 2);
  assert.equal(row!.status, "reworked");
  assert.equal(row!.reworkMinutes, 4);
});

test("an import that fails leaves nothing behind", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const [good] = await load(t, { "p/s1.jsonl": [call("a", "10:00")] });
  const clash = { ...good!, outcome: { ...good!.outcome, workflow: "another" } };
  assert.throws(() => store.logAll([good!, clash]));
  assert.deepEqual(store.workflows(), []);
});

test("conversation text is never kept, and titles only when asked", async (t) => {
  const files = {
    "p/s1.jsonl": [
      JSON.stringify({ type: "ai-title", aiTitle: "SECRET TITLE" }),
      JSON.stringify({ type: "user", message: { content: "SECRET QUESTION" } }),
      call("a", "10:00"),
    ],
  };
  assert.ok(!JSON.stringify(await load(t, files)).includes("SECRET"));
  const [withTitle] = await load(t, files, true);
  assert.equal(withTitle!.outcome.ref, "SECRET TITLE");
  assert.ok(!JSON.stringify(withTitle).includes("SECRET ANSWER"));
});
