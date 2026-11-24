import { readFileSync } from "node:fs";

/** Token counts in one provider-neutral shape. `input` excludes cached tokens. */
export type Usage = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** Cost the provider reported itself, in USD. */
  reportedCost: number | null;
};

/** USD per million tokens. */
export type Rates = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
};
export type Price = Rates & { tiers?: (Rates & { minPromptTokens: number })[] };
export type PriceBook = { fetchedAt: string; source: string; models: Record<string, Price> };

export type Cost = { usd: number | null; source: "reported" | "estimated" | "unknown" };

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Accepts the `usage` object from an Anthropic response or from any
 * OpenAI-compatible one (OpenAI, OpenRouter, Groq). Returns null if it is neither.
 *
 * The two disagree on one thing: Anthropic's input_tokens leaves cached tokens
 * out, OpenAI's prompt_tokens includes them.
 */
export function normaliseUsage(raw: unknown): Usage | null {
  const u = object(raw);

  if ("input_tokens" in u && !("input_tokens_details" in u)) {
    const cacheWriteTotal = count(u.cache_creation_input_tokens);
    const oneHour = Math.min(
      count(object(u.cache_creation).ephemeral_1h_input_tokens),
      cacheWriteTotal,
    );
    return {
      input: count(u.input_tokens),
      cachedInput: count(u.cache_read_input_tokens),
      cacheWrite: cacheWriteTotal - oneHour,
      cacheWrite1h: oneHour,
      output: count(u.output_tokens),
      reportedCost: null,
    };
  }

  if ("prompt_tokens" in u || "input_tokens" in u) {
    const details = object(u.prompt_tokens_details ?? u.input_tokens_details);
    const prompt = count(u.prompt_tokens ?? u.input_tokens);
    const cached = Math.min(count(details.cached_tokens), prompt);
    const written = Math.min(count(details.cache_write_tokens), prompt - cached);
    return {
      input: prompt - cached - written,
      cachedInput: cached,
      cacheWrite: written,
      cacheWrite1h: 0,
      output: count(u.completion_tokens ?? u.output_tokens),
      reportedCost:
        typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null,
    };
  }

  return null;
}

/** "anthropic/claude-opus-5.5" and "claude-opus-5-5" both become "claude-opus-5-5". */
const bareName = (id: string) => id.toLowerCase().split("/").pop()!.replaceAll(".", "-");

export function findPrice(book: PriceBook, model: string): Price | null {
  if (Object.hasOwn(book.models, model)) return book.models[model]!;
  const wanted = bareName(model);
  const matches = Object.keys(book.models).filter((id) => bareName(id) === wanted);
  // An ambiguous name is treated as unknown: a wrong price is worse than none.
  return matches.length === 1 ? book.models[matches[0]!]! : null;
}

/** Never falls back to 0 for an unknown model, because that would hide spend. */
export function costOf(book: PriceBook, model: string, usage: Usage | null): Cost {
  if (!usage) return { usd: null, source: "unknown" };
  if (usage.reportedCost !== null) return { usd: usage.reportedCost, source: "reported" };

  const price = findPrice(book, model);
  if (!price) return { usd: null, source: "unknown" };

  const promptTokens = usage.input + usage.cachedInput + usage.cacheWrite + usage.cacheWrite1h;
  const tier = (price.tiers ?? [])
    .filter((t) => promptTokens > t.minPromptTokens)
    .sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
  const r: Rates = tier ?? price;
  const write = r.cacheWrite ?? r.input;

  const usd =
    (usage.input * r.input +
      usage.cachedInput * (r.cachedInput ?? r.input) +
      usage.cacheWrite * write +
      usage.cacheWrite1h * (r.cacheWrite1h ?? write) +
      usage.output * r.output) /
    1_000_000;
  return { usd, source: "estimated" };
}

export function loadPrices(): PriceBook {
  return JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8")) as PriceBook;
}
