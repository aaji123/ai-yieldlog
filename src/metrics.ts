export type Status = "pending" | "accepted" | "reworked" | "rejected";

export type Workflow = {
  name: string;
  createdAt: number;
  /** USD one verified outcome is worth. Null until someone sets it. */
  valuePerOutcome: number | null;
  /** USD per hour for the person who reviews and fixes. Null until set. */
  hourlyRate: number | null;
  /** USD per month: hosting, SaaS, integration work, governance. */
  fixedMonthly: number;
};

export type Outcome = {
  id: string;
  workflow: string;
  createdAt: number;
  status: Status;
  reviewMinutes: number;
  reworkMinutes: number;
  ref: string | null;
};

export type Call = {
  outcomeId: string;
  model: string;
  costUsd: number | null;
};

export type Summary = {
  outcomes: number;
  pending: number;
  verified: number;
  rejected: number;
  modelCost: number;
  humanCost: number;
  fixedCost: number;
  totalCost: number;
  value: number;
  yield: number;
  firstPassRate: number | null;
  costPerVerified: number | null;
  unpricedCalls: number;
  /** True when a workflow in scope has no value or no hourly rate yet. */
  incomplete: boolean;
};

const DAY = 86_400_000;
const DAYS_PER_MONTH = 365.25 / 12;

export const isVerified = (s: Status) => s === "accepted" || s === "reworked";

export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Share of reviewed outcomes accepted with no human fixing. Pending ones don't count. */
export function firstPassRate(outcomes: Outcome[]): number | null {
  const reviewed = outcomes.filter((o) => o.status !== "pending");
  return ratio(reviewed.filter((o) => o.status === "accepted").length, reviewed.length);
}

const humanCostOf = (o: Outcome, w: Workflow | undefined) =>
  ((o.reviewMinutes + o.reworkMinutes) / 60) * (w?.hourlyRate ?? 0);

/** Fixed cost runs every day the workflow exists, whether or not it was used. */
function fixedCostOf(w: Workflow, from: number, to: number): number {
  const days = Math.max(0, to - Math.max(from, w.createdAt)) / DAY;
  return (w.fixedMonthly / DAYS_PER_MONTH) * days;
}

/**
 * Yield = verified value - full cost of getting it.
 *
 * Cost covers every outcome in the period, including rejected and pending ones:
 * failed attempts are part of what the successes cost.
 */
export function summarise(
  workflows: Workflow[],
  outcomes: Outcome[],
  calls: Call[],
  from: number,
  to: number,
): Summary {
  const byName = new Map(workflows.map((w) => [w.name, w]));
  const ids = new Set(outcomes.map((o) => o.id));
  const inScope = calls.filter((c) => ids.has(c.outcomeId));

  const modelCost = inScope.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
  const humanCost = outcomes.reduce((sum, o) => sum + humanCostOf(o, byName.get(o.workflow)), 0);
  const fixedCost = workflows.reduce((sum, w) => sum + fixedCostOf(w, from, to), 0);
  const totalCost = modelCost + humanCost + fixedCost;

  const verified = outcomes.filter((o) => isVerified(o.status));
  const value = verified.reduce(
    (sum, o) => sum + (byName.get(o.workflow)?.valuePerOutcome ?? 0),
    0,
  );

  return {
    outcomes: outcomes.length,
    pending: outcomes.filter((o) => o.status === "pending").length,
    verified: verified.length,
    rejected: outcomes.filter((o) => o.status === "rejected").length,
    modelCost,
    humanCost,
    fixedCost,
    totalCost,
    value,
    yield: value - totalCost,
    firstPassRate: firstPassRate(outcomes),
    costPerVerified: ratio(totalCost, verified.length),
    unpricedCalls: inScope.filter((c) => c.costUsd === null).length,
    incomplete: workflows.some((w) => w.valuePerOutcome === null || w.hourlyRate === null),
  };
}

export type MixRow = {
  workflow: string;
  models: string;
  reviewed: number;
  firstPassRate: number | null;
  modelCostPerVerified: number | null;
  /** Model plus human cost. Fixed cost is left out: it doesn't depend on the model. */
  variableCostPerVerified: number | null;
};

/**
 * Compares the sets of models used for the same workflow. Grouped by workflow so
 * an easy task can't make one model look better than another. Pending outcomes are
 * left out, or a model with a long review queue would look worse than it is.
 */
export function compareModels(workflows: Workflow[], outcomes: Outcome[], calls: Call[]): MixRow[] {
  const byName = new Map(workflows.map((w) => [w.name, w]));
  const callsBy = Map.groupBy(calls, (c) => c.outcomeId);
  const reviewed = outcomes.filter((o) => o.status !== "pending" && callsBy.has(o.id));

  const groups = Map.groupBy(reviewed, (o) => {
    const models = [...new Set(callsBy.get(o.id)!.map((c) => c.model))].sort().join(" + ");
    return JSON.stringify([o.workflow, models]);
  });

  return [...groups]
    .map(([key, group]): MixRow => {
      const [workflow, models] = JSON.parse(key) as [string, string];
      const groupCalls = group.flatMap((o) => callsBy.get(o.id)!);
      const priced = groupCalls.every((c) => c.costUsd !== null);
      const model = groupCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
      const human = group.reduce((s, o) => s + humanCostOf(o, byName.get(workflow)), 0);
      const verified = group.filter((o) => isVerified(o.status)).length;
      return {
        workflow,
        models,
        reviewed: group.length,
        firstPassRate: firstPassRate(group),
        modelCostPerVerified: priced ? ratio(model, verified) : null,
        variableCostPerVerified: priced ? ratio(model + human, verified) : null,
      };
    })
    .sort((a, b) => a.workflow.localeCompare(b.workflow) || b.reviewed - a.reviewed);
}

export type WeekPoint = { week: number; reviewed: number; firstPassRate: number };

/** Weeks start on Monday, UTC. Weeks with nothing reviewed are left out. */
export function weekly(outcomes: Outcome[]): WeekPoint[] {
  const weekOf = (t: number) => {
    const day = Math.floor(t / DAY);
    return (day - ((day + 3) % 7)) * DAY; // 1970-01-01 was a Thursday
  };
  return [...Map.groupBy(outcomes, (o) => weekOf(o.createdAt))]
    .flatMap(([week, group]) => {
      const rate = firstPassRate(group);
      const reviewed = group.filter((o) => o.status !== "pending").length;
      return rate === null ? [] : [{ week, reviewed, firstPassRate: rate }];
    })
    .sort((a, b) => a.week - b.week);
}
