/** Runs the dashboard on made-up data, kept in memory and separate from yours. */
import { listen } from "./server.ts";
import { costOf, loadPrices, normaliseUsage } from "./pricing.ts";
import { Store } from "./store.ts";

const DAY = 86_400_000;
const prices = loadPrices();
const store = new Store(":memory:");
const start = Date.now() - 56 * DAY;

// A fixed seed, so the demo looks the same every time.
let seed = 7;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = (a: number, b: number) => a + random() * (b - a);

type Demo = {
  name: string;
  value: number;
  rate: number;
  fixed: number;
  perDay: number;
  steps: string[];
  mixes: { models: string[]; firstPass: number; rejected: number }[];
  review: [number, number];
  rework: [number, number];
};

const demos: Demo[] = [
  {
    name: "DEMO story scene",
    value: 4,
    rate: 30,
    fixed: 25,
    perDay: 3,
    steps: ["outline", "scene"],
    mixes: [
      { models: ["openai/gpt-4o-mini"], firstPass: 0.48, rejected: 0.2 },
      { models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-5.5"], firstPass: 0.74, rejected: 0.08 },
    ],
    review: [1, 3],
    rework: [4, 10],
  },
  {
    name: "DEMO inventory check",
    value: 1.5,
    rate: 40,
    fixed: 60,
    perDay: 2,
    steps: ["check"],
    mixes: [{ models: ["anthropic/claude-haiku-5.5"], firstPass: 0.7, rejected: 0.12 }],
    review: [1, 2],
    rework: [3, 8],
  },
];

let id = 0;
for (const d of demos) {
  store.ensureWorkflow(d.name, start);
  store.setWorkflow(d.name, { valuePerOutcome: d.value, hourlyRate: d.rate, fixedMonthly: d.fixed });

  for (let day = 0; day < 56; day++) {
    const total = Math.round(d.perDay * between(0.5, 1.5));
    for (let i = 0; i < total; i++) {
      const at = Math.round(start + (day + between(0.3, 0.9)) * DAY);
      const mix = d.mixes[Math.floor(random() * d.mixes.length)]!;
      const outcome = { id: `demo-${id}`, workflow: d.name, ref: `Example ${++id}` };

      d.steps.forEach((step, n) => {
        const model = mix.models[Math.min(n, mix.models.length - 1)]!;
        const usage = normaliseUsage({
          prompt_tokens: Math.round(between(600, 1800)),
          completion_tokens: Math.round(between(300, 1400)),
        });
        store.log(
          outcome,
          {
            id: `${outcome.id}-${n}`,
            step,
            model,
            usage,
            cost: costOf(prices, model, usage),
            latencyMs: Math.round(between(900, 9000)),
            ok: true,
          },
          at,
        );
      });

      if (day > 53 && random() < 0.6) continue; // leave a few to review
      const roll = random();
      const status =
        roll < mix.firstPass ? "accepted" : roll > 1 - mix.rejected ? "rejected" : "reworked";
      store.review(outcome.id, {
        status,
        reviewMinutes: Math.round(between(...d.review)),
        reworkMinutes: status === "reworked" ? Math.round(between(...d.rework)) : 0,
      });
    }
  }
}

listen(store, Number(process.env.PORT ?? 4601));
