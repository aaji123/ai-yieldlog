import { readFileSync } from "node:fs";

/** Token counts in one provider-neutral shape. `input` excludes cached tokens. */
export type Usage = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** Full cost the provider reported itself, in USD. */
  reportedCost: number | null;
  /** Known fee that comes on top of the model's own price. */
  fee: number;
  /** False when the call was billed at some other rate than the list price. */
  listPriced: boolean;
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

const MAX_TOKENS = 1_000_000_000;

/** Above this, a reported cost for one call is taken as a mistake. */
const MAX_CALL_COST = 1000;

class BadUsage extends Error {}

/** A missing count is 0, but a nonsensical one makes the whole usage unusable. */
function count(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !(v >= 0 && v <= MAX_TOKENS)) throw new BadUsage();
  return Math.round(v);
}

function requiredCount(v: unknown): number {
  if (v === undefined || v === null) throw new BadUsage();
  return count(v);
}

const dollars = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * OpenRouter reports a cost. When it uses your own provider key (BYOK), that cost
 * is only OpenRouter's fee, and the provider's charge has to be added. For other
 * calls the provider's charge is already included.
 */
function reported(u: Record<string, unknown>): Pick<Usage, "reportedCost" | "fee"> {
  const cost = dollars(u.cost);
  if (u.is_byok !== true) return { reportedCost: cost, fee: 0 };
  const upstream = dollars(object(u.cost_details).upstream_inference_cost);
  return upstream === null
    ? { reportedCost: null, fee: cost ?? 0 }
    : { reportedCost: upstream + (cost ?? 0), fee: 0 };
}

/**
 * Accepts the `usage` object from an Anthropic response or from any
 * OpenAI-compatible one (OpenAI, OpenRouter, Groq). Returns null if it is neither,
 * or if its numbers make no sense.
 *
 * The two disagree on one thing: Anthropic's input_tokens leaves cached tokens
 * out, OpenAI's prompt_tokens includes them.
 */
export function normaliseUsage(raw: unknown): Usage | null {
  try {
    return parseUsage(object(raw));
  } catch (error) {
    if (error instanceof BadUsage) return null;
    throw error;
  }
}

/** Anthropic's price for one web search, in USD. */
const WEB_SEARCH_PRICE = 0.01;

/**
 * Anthropic charges other rates for fast mode, batches, some regions, and for calls
 * where a second model stepped in. Their token counts alone don't give the cost.
 */
function isListPriced(u: Record<string, unknown>): boolean {
  const usual = (v: unknown, ...allowed: string[]) =>
    v === undefined || v === null || allowed.includes(v as string);
  const iterations = Array.isArray(u.iterations) ? u.iterations : [];
  return (
    usual(u.speed, "standard") &&
    usual(u.service_tier, "standard") &&
    usual(u.inference_geo, "global", "not_available", "") &&
    iterations.every((i) => object(i).type === "message")
  );
}

function parseUsage(u: Record<string, unknown>): Usage | null {
  if ("input_tokens" in u && !("input_tokens_details" in u)) {
    const cacheWriteTotal = count(u.cache_creation_input_tokens);
    const oneHour = Math.min(
      count(object(u.cache_creation).ephemeral_1h_input_tokens),
      cacheWriteTotal,
    );
    const cost = reported(u);
    const searches = count(object(u.server_tool_use).web_search_requests);
    return {
      input: requiredCount(u.input_tokens),
      cachedInput: count(u.cache_read_input_tokens),
      cacheWrite: cacheWriteTotal - oneHour,
      cacheWrite1h: oneHour,
      output: count(u.output_tokens),
      reportedCost: cost.reportedCost,
      fee: cost.fee + searches * WEB_SEARCH_PRICE,
      listPriced: isListPriced(u),
    };
  }

  if ("prompt_tokens" in u || "input_tokens" in u) {
    const details = object(u.prompt_tokens_details ?? u.input_tokens_details);
    const prompt = requiredCount(u.prompt_tokens ?? u.input_tokens);
    const cached = Math.min(count(details.cached_tokens), prompt);
    const written = Math.min(count(details.cache_write_tokens), prompt - cached);
    return {
      input: prompt - cached - written,
      cachedInput: cached,
      cacheWrite: written,
      cacheWrite1h: 0,
      output: count(u.completion_tokens ?? u.output_tokens),
      ...reported(u),
      listPriced: true,
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

/** Never falls back to 0 when the cost isn't known, because that would hide spend. */
export function costOf(book: PriceBook, model: string, usage: Usage | null): Cost {
  if (!usage) return { usd: null, source: "unknown" };
  const list = listCost(book, model, usage);

  if (usage.reportedCost !== null) {
    // Tools and search can cost more than the tokens, so small gaps are normal. A
    // large one is more likely cents sent as dollars than a real price.
    const unbelievable =
      usage.reportedCost > MAX_CALL_COST ||
      (list !== null && usage.reportedCost > 1 && usage.reportedCost > list * 20);
    return unbelievable
      ? { usd: null, source: "unknown" }
      : { usd: usage.reportedCost, source: "reported" };
  }
  return list === null || usage.fee > MAX_CALL_COST
    ? { usd: null, source: "unknown" }
    : { usd: list + usage.fee, source: "estimated" };
}

function listCost(book: PriceBook, model: string, usage: Usage): number | null {
  const price = findPrice(book, model);
  if (!price || !usage.listPriced) return null;

  const promptTokens = usage.input + usage.cachedInput + usage.cacheWrite + usage.cacheWrite1h;
  const tier = (price.tiers ?? [])
    .filter((t) => promptTokens > t.minPromptTokens)
    .sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
  const r: Rates = tier ?? price;
  const write = r.cacheWrite ?? r.input;

  return (
    (usage.input * r.input +
      usage.cachedInput * (r.cachedInput ?? r.input) +
      usage.cacheWrite * write +
      usage.cacheWrite1h * (r.cacheWrite1h ?? write) +
      usage.output * r.output) /
    1_000_000
  );
}

export function loadPrices(): PriceBook {
  return JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8")) as PriceBook;
}
