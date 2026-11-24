import { writeFileSync } from "node:fs";
import type { Price, PriceBook, Rates } from "./pricing.ts";

const SOURCE = "https://openrouter.ai/api/v1/models";
type Raw = Record<string, unknown>;

const perMillion = (v: unknown): number | undefined => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  // Negative prices mark routers whose price depends on the model they pick.
  return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toPrecision(12)) : undefined;
};

function rates(p: Raw): Rates | null {
  const input = perMillion(p.prompt);
  const output = perMillion(p.completion);
  if (input === undefined || output === undefined) return null;
  const r: Rates = { input, output };
  const cachedInput = perMillion(p.input_cache_read);
  const cacheWrite = perMillion(p.input_cache_write);
  const cacheWrite1h = perMillion(p.input_cache_write_1h);
  if (cachedInput !== undefined) r.cachedInput = cachedInput;
  if (cacheWrite !== undefined) r.cacheWrite = cacheWrite;
  if (cacheWrite1h !== undefined) r.cacheWrite1h = cacheWrite1h;
  return r;
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Price list request failed: HTTP ${response.status}`);
const { data } = (await response.json()) as { data: { id: string; pricing: Raw }[] };

const models: Record<string, Price> = {};
for (const { id, pricing } of data.sort((a, b) => (a.id < b.id ? -1 : 1))) {
  const base = rates(pricing);
  if (!base) continue;
  const overrides = Array.isArray(pricing.overrides) ? (pricing.overrides as Raw[]) : [];
  const tiers = overrides.flatMap((o) => {
    const r = rates({ ...pricing, ...o });
    return r && typeof o.min_prompt_tokens === "number"
      ? [{ ...r, minPromptTokens: o.min_prompt_tokens }]
      : [];
  });
  models[id] = tiers.length ? { ...base, tiers } : base;
}

const book: PriceBook = { fetchedAt: new Date().toISOString(), source: SOURCE, models };
writeFileSync(new URL("../prices.json", import.meta.url), JSON.stringify(book, null, 1) + "\n");
console.log(`Saved prices for ${Object.keys(models).length} models.`);
