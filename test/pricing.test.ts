import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, findPrice, normaliseUsage, type PriceBook } from "../src/pricing.ts";

const book: PriceBook = {
  fetchedAt: "",
  source: "",
  models: {
    "a/big": { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    "a/plain-1.5": { input: 1, output: 2 },
    "a/tiered": { input: 1, output: 1, tiers: [{ minPromptTokens: 100, input: 5, output: 5 }] },
    "x/same": { input: 1, output: 1 },
    "y/same": { input: 9, output: 9 },
  },
};

const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("Anthropic usage keeps cached tokens separate from input", () => {
  const u = normaliseUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_1h_input_tokens: 100 },
  });
  assert.deepEqual(u, {
    input: 100,
    cachedInput: 1000,
    cacheWrite: 200,
    cacheWrite1h: 100,
    output: 50,
    reportedCost: null,
    fee: 0,
  });
  near(
    costOf(book, "a/big", u).usd,
    (100 * 4 + 1000 * 0.2 + 200 * 5 + 100 * 8 + 50 * 20) / 1e6,
  );
});

test("OpenAI-style usage takes cached tokens out of the prompt count", () => {
  const u = normaliseUsage({
    prompt_tokens: 1000,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 400 },
  });
  assert.equal(u?.input, 600);
  assert.equal(u?.cachedInput, 400);
});

test("OpenAI Responses API usage is not mistaken for Anthropic's", () => {
  const u = normaliseUsage({
    input_tokens: 1000,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 400 },
  });
  assert.equal(u?.input, 600);
});

test("a cost the provider reports wins over an estimate", () => {
  const u = normaliseUsage({ prompt_tokens: 1000, completion_tokens: 10, cost: 0.5 });
  assert.deepEqual(costOf(book, "a/big", u), { usd: 0.5, source: "reported" });
});

test("unknown models and missing usage cost null, never zero", () => {
  const u = normaliseUsage({ prompt_tokens: 1, completion_tokens: 1 });
  assert.deepEqual(costOf(book, "nope", u), { usd: null, source: "unknown" });
  assert.deepEqual(costOf(book, "a/big", null), { usd: null, source: "unknown" });
  assert.equal(normaliseUsage("junk"), null);
  assert.equal(normaliseUsage({}), null);
});

test("native model ids match, ambiguous ones do not", () => {
  assert.ok(findPrice(book, "plain-1-5"));
  assert.equal(findPrice(book, "same"), null);
  assert.equal(findPrice(book, "constructor"), null);
});

test("missing cache prices fall back to the input price", () => {
  const u = normaliseUsage({
    prompt_tokens: 1000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 1000 },
  });
  near(costOf(book, "a/plain-1.5", u).usd, 0.001);
});

test("long prompts use the higher tier only past the threshold", () => {
  const at = (n: number) =>
    costOf(book, "a/tiered", normaliseUsage({ prompt_tokens: n, completion_tokens: 0 })).usd;
  near(at(100), 100 / 1e6);
  near(at(101), 505 / 1e6);
});

test("nonsensical counts make the cost unknown, not zero", () => {
  const bad: unknown[] = [-5, "9", NaN, Infinity, 1e300, {}, true];
  for (const value of bad) {
    assert.equal(normaliseUsage({ prompt_tokens: value, completion_tokens: 1 }), null, String(value));
    assert.equal(normaliseUsage({ prompt_tokens: 1, completion_tokens: value }), null, String(value));
    assert.equal(normaliseUsage({ input_tokens: 1, output_tokens: value }), null, String(value));
  }
  assert.equal(normaliseUsage({ prompt_tokens: null, completion_tokens: null }), null);
  assert.equal(normaliseUsage({ prompt_tokens: 5 })?.output, 0); // embeddings have no output
});

test("OpenRouter calls on your own key add the provider's charge to the fee", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 0, cost: 0.01, is_byok: true };
  const cost = (extra: object) => costOf(book, "a/big", normaliseUsage({ ...usage, ...extra }));

  near(cost({ cost_details: { upstream_inference_cost: 0.2 } }).usd, 0.21);
  near(cost({ cost: 0, cost_details: { upstream_inference_cost: 0.2 } }).usd, 0.2);

  // The provider's charge is missing: list price plus the fee, marked as an estimate.
  const estimated = cost({ cost_details: { upstream_inference_cost: null } });
  near(estimated.usd, 0.004 + 0.01);
  assert.equal(estimated.source, "estimated");
});

test("OpenRouter calls on its own key don't count the provider's charge twice", () => {
  const u = normaliseUsage({
    prompt_tokens: 1,
    completion_tokens: 1,
    cost: 0.2,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0.2 },
  });
  near(costOf(book, "a/big", u).usd, 0.2);
});

test("a cost reported in an Anthropic-style response is used", () => {
  const u = normaliseUsage({ input_tokens: 1, output_tokens: 1, cost: 0.3 });
  assert.deepEqual(costOf(book, "a/big", u), { usd: 0.3, source: "reported" });
});

test("unbelievable reported costs are unknown, plausible ones are kept", () => {
  const source = (model: string, cost: number, extra = {}) =>
    costOf(book, model, normaliseUsage({ prompt_tokens: 1000, completion_tokens: 0, cost, ...extra })).source;
  assert.equal(source("a/big", 1e12), "unknown");
  assert.equal(source("nope", 1001), "unknown");
  assert.equal(source("a/big", 5), "unknown"); // list price is $0.004
  assert.equal(source("a/big", 0.5), "reported"); // could be tools or search
  assert.equal(source("nope", 5), "reported"); // nothing to compare with
  assert.equal(source("a/big", 1e12, { is_byok: true }), "unknown");
});
