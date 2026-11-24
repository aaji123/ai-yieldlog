import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/server.ts";
import { startOutcome } from "../clients/yieldlog.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
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

test("a stopped tracker doesn't break the app", async (t) => {
  t.mock.method(console, "warn", () => {});
  const run = await startOutcome({ workflow: "w", url: "http://127.0.0.1:1" });
  await run.logCall({ model: "a/m" });
});

test("the Python client doesn't break the app either", (t) => {
  const code =
    "import sys; sys.path.insert(0, 'clients'); from yieldlog import Outcome; " +
    "Outcome('w', url='http://127.0.0.1:1').log_call('m', {'prompt_tokens': 1}); print('ok')";
  const run = spawnSync("python", ["-B", "-c", code], { encoding: "utf8" });
  if (run.error) return t.skip("Python is not installed");
  assert.equal(run.stdout.trim(), "ok", run.stderr);
});
