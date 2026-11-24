import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareModels,
  summarise,
  weekly,
  type Call,
  type Outcome,
  type Status,
  type Workflow,
} from "../src/metrics.ts";

const DAY = 86_400_000;
let n = 0;

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  name: "w",
  createdAt: 0,
  valuePerOutcome: 10,
  hourlyRate: 60,
  fixedMonthly: 0,
  ...over,
});
const out = (status: Status, over: Partial<Outcome> = {}): Outcome => ({
  id: `o${n++}`,
  workflow: "w",
  createdAt: 0,
  status,
  reviewMinutes: 0,
  reworkMinutes: 0,
  ref: null,
  ...over,
});
const call = (o: Outcome, costUsd: number | null, model = "m"): Call => ({
  outcomeId: o.id,
  model,
  costUsd,
});
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("yield is verified value minus model, human and fixed cost", () => {
  const a = out("accepted", { reviewMinutes: 1 });
  const b = out("reworked", { reviewMinutes: 1, reworkMinutes: 3 });
  const c = out("rejected", { reviewMinutes: 1 });
  const s = summarise(
    [wf({ fixedMonthly: 30.4375 })],
    [a, b, c],
    [call(a, 1), call(b, 1), call(c, 1)],
    0,
    2 * DAY,
  );
  near(s.modelCost, 3);
  near(s.humanCost, 6);
  near(s.fixedCost, 2);
  near(s.value, 20);
  near(s.yield, 9);
  near(s.costPerVerified, 5.5);
  near(s.firstPassRate, 1 / 3);
});

test("pending outcomes cost money but don't move the first-pass rate", () => {
  const a = out("accepted");
  const p = out("pending");
  const s = summarise([wf()], [a, p], [call(a, 1), call(p, 4)], 0, DAY);
  near(s.modelCost, 5);
  near(s.firstPassRate, 1);
  near(s.value, 10);
  assert.equal(s.pending, 1);
});

test("nothing verified gives null, not zero or infinity", () => {
  const s = summarise([wf()], [out("pending")], [], 0, DAY);
  assert.equal(s.costPerVerified, null);
  assert.equal(s.firstPassRate, null);
});

test("fixed cost starts when the workflow does and is never negative", () => {
  const w = wf({ createdAt: 9 * DAY, fixedMonthly: 30.4375 });
  near(summarise([w], [], [], 0, 10 * DAY).fixedCost, 1);
  near(summarise([w], [], [], 0, 5 * DAY).fixedCost, 0);
});

test("unpriced calls are counted and unset values are flagged", () => {
  const a = out("accepted");
  const s = summarise(
    [wf({ valuePerOutcome: null })],
    [a],
    [call(a, null), call(a, 1)],
    0,
    DAY,
  );
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.incomplete, true);
});

test("calls from outcomes outside the period are ignored", () => {
  const a = out("accepted");
  const old = out("accepted");
  near(summarise([wf()], [a], [call(a, 1), call(old, 99)], 0, DAY).modelCost, 1);
});

test("models are compared within a workflow, by the set used", () => {
  const a = out("accepted");
  const b = out("rejected");
  const c = out("accepted");
  const p = out("pending");
  const other = out("accepted", { workflow: "x" });
  const rows = compareModels(
    [wf(), wf({ name: "x" })],
    [a, b, c, p, other],
    [
      call(a, 1, "m2"),
      call(a, 1, "m1"),
      call(b, 1, "m1"),
      call(b, 1, "m2"),
      call(b, 1, "m1"),
      call(c, 0.1, "m1"),
      call(p, 50, "m1"),
      call(other, 7, "m1"),
    ],
  );
  assert.deepEqual(
    rows.map((r) => [r.workflow, r.models, r.reviewed]),
    [
      ["w", "m1 + m2", 2],
      ["w", "m1", 1],
      ["x", "m1", 1],
    ],
  );
  near(rows[0]!.modelCostPerVerified, 5); // 2 + 3 spent, one verified
  near(rows[1]!.modelCostPerVerified, 0.1); // the pending call is left out
});

test("a model mix with an unpriced call shows no cost rather than a low one", () => {
  const a = out("accepted");
  assert.equal(compareModels([wf()], [a], [call(a, null)])[0]!.modelCostPerVerified, null);
});

test("weeks start on Monday and skip unreviewed weeks", () => {
  const on = (status: Status, iso: string) => out(status, { createdAt: Date.parse(iso) });
  const points = weekly([
    on("accepted", "2026-11-23T00:00:00Z"), // Monday
    on("rejected", "2026-11-29T23:59:59Z"), // Sunday, same week
    on("accepted", "2026-11-22T23:59:59Z"), // the Sunday before
    on("pending", "2026-11-02T12:00:00Z"),
  ]);
  assert.deepEqual(
    points.map((p) => [new Date(p.week).toISOString().slice(0, 10), p.reviewed, p.firstPassRate]),
    [
      ["2026-11-16", 1, 1],
      ["2026-11-23", 2, 0.5],
    ],
  );
});
