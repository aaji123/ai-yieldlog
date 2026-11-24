import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { createApp } from "../src/server.ts";
import { startOutcome } from "../clients/yieldlog.ts";
import { Store } from "../src/store.ts";

const NOW = Date.now();
const DAY = 86_400_000;
const prices = { fetchedAt: "", source: "", models: { "a/m": { input: 1, output: 2 } } };
let store: Store;
let server: Server;
let url: string;

before(async () => {
  store = new Store(":memory:");
  server = createApp(store, prices, () => NOW);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  store.close();
});

const post = (path: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const report = async (query = "") =>
  (await (await fetch(`${url}/api/report?days=30${query}`)).json()) as any;

test("the client logs an outcome that can be valued and reviewed", async () => {
  const run = await startOutcome({ workflow: "story", ref: "r1", url });
  await run.logCall({ model: "a/m", step: "outline", usage: { prompt_tokens: 1e6, completion_tokens: 0 } });
  await run.logCall({ model: "a/m", step: "scene", usage: { prompt_tokens: 0, completion_tokens: 1e6 } });

  const review = { outcomeId: run.id, status: "reworked", reviewMinutes: 2, reworkMinutes: 4 };
  assert.equal((await post("/api/review", review)).status, 200);
  const values = { name: "story", valuePerOutcome: 20, hourlyRate: 60, fixedMonthly: 0 };
  assert.equal((await post("/api/workflow", values)).status, 200);

  const { summary, models, outcomes } = await report("&workflow=story");
  assert.equal(summary.modelCost, 3);
  assert.equal(summary.humanCost, 6);
  assert.equal(summary.yield, 11);
  assert.equal(summary.firstPassRate, 0);
  assert.equal(models[0].variableCostPerVerified, 9);
  assert.equal(outcomes[0].calls, 2);
});

test("the same log sent twice counts once", async () => {
  const body = {
    outcomeId: "dup",
    workflow: "dup",
    call: { id: "c1", model: "a/m", usage: { prompt_tokens: 1e6, completion_tokens: 0 } },
  };
  await post("/api/log", body);
  await post("/api/log", body);
  assert.equal((await report("&workflow=dup")).summary.modelCost, 1);
});

test("an outcome can't move between workflows, and the attempt leaves nothing behind", async () => {
  await post("/api/log", { outcomeId: "fixed", workflow: "one" });
  assert.equal((await post("/api/log", { outcomeId: "fixed", workflow: "two" })).status, 409);
  assert.ok(!(await report()).workflowNames.includes("two"));
});

test("an unknown model is flagged instead of counted as free", async () => {
  await post("/api/log", {
    outcomeId: "u",
    workflow: "unknown",
    call: { id: "u1", model: "??", usage: { prompt_tokens: 5, completion_tokens: 5 } },
  });
  assert.equal((await report("&workflow=unknown")).summary.unpricedCalls, 1);
});

test("bad input is refused", async () => {
  const cases: [string, unknown, number][] = [
    ["/api/log", "{", 400],
    ["/api/log", [], 400],
    ["/api/log", { outcomeId: "x" }, 400],
    ["/api/log", { outcomeId: "x", workflow: "  " }, 400],
    ["/api/log", { outcomeId: "x", workflow: "w", call: "no" }, 400],
    ["/api/log", { outcomeId: "x", workflow: "y".repeat(101) }, 400],
    ["/api/review", { outcomeId: "x", status: "great", reviewMinutes: 0, reworkMinutes: 0 }, 400],
    ["/api/review", { outcomeId: "x", status: "accepted", reviewMinutes: 0, reworkMinutes: 5 }, 400],
    ["/api/review", { outcomeId: "x", status: "accepted", reviewMinutes: -1, reworkMinutes: 0 }, 400],
    ["/api/review", { outcomeId: "x", status: "accepted", reviewMinutes: 1, reworkMinutes: 0 }, 404],
    ["/api/workflow", { name: "none", fixedMonthly: 0 }, 404],
    ["/api/nope", {}, 404],
    ["/api/log", { outcomeId: "x", workflow: "w", pad: "y".repeat(70_000) }, 413],
  ];
  for (const [path, body, status] of cases) {
    const response = await post(path, body);
    assert.equal(response.status, status, `${path} ${JSON.stringify(body).slice(0, 80)}`);
    await response.text();
  }
  for (const query of ["days=0", "days=1.5", "days=abc"]) {
    assert.equal((await fetch(`${url}/api/report?${query}`)).status, 400, query);
  }
  assert.equal((await fetch(`${url}/api/report?workflow=missing`)).status, 404);
});

test("another website can't write to the tracker", async () => {
  const simple = await fetch(`${url}/api/log`, { method: "POST", body: "{}" });
  assert.equal(simple.status, 415);
  const preflight = await fetch(`${url}/api/log`, { method: "OPTIONS" });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);

  const status = await new Promise((done) =>
    request(`${url}/api/report`, { headers: { host: "evil.example" } }, (r) => {
      r.resume();
      done(r.statusCode);
    }).end(),
  );
  assert.equal(status, 403);
});

test("files outside public/ are not served", async () => {
  for (const path of ["/../package.json", "/..%2fpackage.json", "/yieldlog.db"]) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
});

test("a malformed address is refused without an error", async () => {
  assert.equal((await fetch(`${url}//`)).status, 400);
});

test("a call with impossible numbers is kept and flagged", async () => {
  const call = { id: "big", model: "a/m", usage: { prompt_tokens: 1e300, completion_tokens: 1 } };
  assert.equal((await post("/api/log", { outcomeId: "big", workflow: "big", call })).status, 201);
  assert.equal((await report("&workflow=big")).summary.unpricedCalls, 1);
});

test("late calls keep their own time, in any order", async () => {
  const send = (daysAgo: number, id: string) =>
    post("/api/log", {
      outcomeId: "late",
      workflow: "late",
      at: NOW - daysAgo * DAY,
      call: { id, model: "a/m", usage: { prompt_tokens: 1, completion_tokens: 0 } },
    });
  await send(1, "l1");
  await send(10, "l2");
  await send(5, "l3");
  const { outcomes, workflows } = await report("&workflow=late");
  assert.equal(outcomes[0].createdAt, NOW - 10 * DAY);
  assert.equal(workflows[0].createdAt, NOW - 10 * DAY);
  assert.equal(outcomes[0].calls, 3);

  for (const at of [NOW + DAY, NOW - 366 * DAY, "now", -1]) {
    const response = await post("/api/log", { outcomeId: "t", workflow: "t", at });
    assert.equal(response.status, 400, String(at));
  }
});

const STOPPED = "http://127.0.0.1:1";
const tempDir = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "yieldlog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("calls made while the tracker is off are kept and sent later, once", async (t) => {
  t.mock.method(console, "warn", () => {});
  const unsentDir = tempDir(t);
  const usage = { prompt_tokens: 1e6, completion_tokens: 0 };

  const offline = await startOutcome({ workflow: "outage", url: STOPPED, unsentDir });
  await offline.logCall({ model: "a/m", usage });
  assert.equal(readdirSync(unsentDir).length, 2);

  const online = await startOutcome({ workflow: "outage", url, unsentDir });
  await online.logCall({ model: "a/m", usage });
  assert.deepEqual(readdirSync(unsentDir), []);

  const { summary } = await report("&workflow=outage");
  assert.equal(summary.outcomes, 2);
  assert.equal(summary.modelCost, 2);
});

test("two apps resending at the same time don't double the cost", async (t) => {
  t.mock.method(console, "warn", () => {});
  const unsentDir = tempDir(t);
  const offline = await startOutcome({ workflow: "race", url: STOPPED, unsentDir });
  for (let i = 0; i < 10; i++) {
    await offline.logCall({ model: "a/m", usage: { prompt_tokens: 1e6, completion_tokens: 0 } });
  }
  await Promise.all([1, 2, 3].map(() => startOutcome({ workflow: "other", url, unsentDir })));
  assert.equal((await report("&workflow=race")).summary.modelCost, 10);
  assert.deepEqual(readdirSync(unsentDir), []);
});

test("a kept call the tracker refuses doesn't block the rest", async (t) => {
  t.mock.method(console, "warn", () => {});
  const unsentDir = tempDir(t);
  writeFileSync(join(unsentDir, "0-broken.json"), "{");
  const offline = await startOutcome({ workflow: "poison", url: STOPPED, unsentDir });
  await offline.logCall({ model: "a/m", usage: { prompt_tokens: 1e6, completion_tokens: 0 } });
  await startOutcome({ workflow: "other", url, unsentDir });
  assert.deepEqual(readdirSync(unsentDir), ["0-broken.json.refused"]);
  assert.equal((await report("&workflow=poison")).summary.modelCost, 1);
});

test("the client never throws, even when it can't keep the call", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const file = join(tempDir(t), "a-file");
  writeFileSync(file, "");
  const run = await startOutcome({ workflow: "w", url: STOPPED, unsentDir: file });
  await run.logCall({ model: "a/m", usage: { tokens: 1n } });
  assert.ok(warn.mock.calls.every((c) => String(c.arguments[0]).includes("LOST")));
});

const pythonMissing = spawnSync("python", ["--version"]).error !== undefined;

test("the Python client keeps and resends calls too", { skip: pythonMissing }, async (t) => {
  const dir = tempDir(t);
  const python = async (lines: string[]) => {
    const script = ["import sys", "sys.path.insert(0, 'clients')", "from yieldlog import Outcome", ...lines];
    const child = spawn("python", ["-B", "-c", script.join("\n"), dir, url]);
    const [out, err] = await Promise.all([text(child.stdout), text(child.stderr)]);
    assert.equal(out.trim(), "ok", err);
  };
  const usage = "{'prompt_tokens': 1000000, 'completion_tokens': 0}";
  writeFileSync(join(dir, "0-broken.json"), "{");

  await python([
    `run = Outcome('python', url='${STOPPED}', unsent_dir=sys.argv[1])`,
    `run.log_call('a/m', ${usage})`,
    "run.log_call('a/m', {'bad': object()})", // must not raise
    "print('ok')",
  ]);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 3);

  await python([
    "run = Outcome('python', url=sys.argv[2], unsent_dir=sys.argv[1])",
    `run.log_call('a/m', ${usage})`,
    "print('ok')",
  ]);
  assert.deepEqual(readdirSync(dir), ["0-broken.json.refused"]);
  const { summary } = await report("&workflow=python");
  assert.equal(summary.outcomes, 2);
  assert.equal(summary.modelCost, 2);
});
