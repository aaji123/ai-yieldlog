import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareModels, summarise, weekly, type Status } from "./metrics.ts";
import { costOf, loadPrices, normaliseUsage, type PriceBook } from "./pricing.ts";
import { ConflictError, Store, type NewCall } from "./store.ts";

const MAX_BODY = 64 * 1024;
const LIST_LIMIT = 50;
const DAY = 86_400_000;
const MAX_AGE = 365 * DAY;
const MAX_CLOCK_SKEW = 5 * 60_000;
const STATUSES = ["pending", "accepted", "reworked", "rejected"];

const FILES: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

function text(body: Body, key: string, max: number): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw new HttpError(400, `"${key}" must be text of 1-${max} characters.`);
  }
  return v.trim();
}

const optionalText = (body: Body, key: string, max: number): string | null =>
  body[key] === undefined || body[key] === null ? null : text(body, key, max);

function amount(body: Body, key: string, max: number): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
    throw new HttpError(400, `"${key}" must be a number from 0 to ${max}.`);
  }
  return v;
}

const optionalAmount = (body: Body, key: string, max: number): number | null =>
  body[key] === undefined || body[key] === null ? null : amount(body, key, max);

async function readBody(req: IncomingMessage): Promise<Body> {
  // Requiring JSON makes browsers send a CORS preflight, which this server never
  // approves, so other websites can't write to it.
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Send application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request must be a JSON object.");
  }
  return parsed as Body;
}

function parseCall(raw: unknown, prices: PriceBook): NewCall | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, `"call" must be an object.`);
  }
  const body = raw as Body;
  const model = text(body, "model", 200);
  const usage = normaliseUsage(body.usage);
  const latency = optionalAmount(body, "latencyMs", DAY);
  return {
    id: text(body, "id", 100),
    step: optionalText(body, "step", 100),
    model,
    usage,
    cost: costOf(prices, model, usage),
    latencyMs: latency === null ? null : Math.round(latency),
    ok: body.ok !== false,
  };
}

/** When the call was made. Clients send it because a resent call arrives late. */
function parseTime(body: Body, now: number): number {
  const at = body.at;
  if (at === undefined || at === null) return now;
  if (typeof at !== "number" || !(at >= now - MAX_AGE && at <= now + MAX_CLOCK_SKEW)) {
    throw new HttpError(400, `"at" must be a time in milliseconds within the last year.`);
  }
  return Math.min(Math.round(at), now);
}

function report(store: Store, prices: PriceBook, query: URLSearchParams, now: number) {
  const days = Number(query.get("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new HttpError(400, `"days" must be a whole number from 1 to 3650.`);
  }
  const from = now - days * DAY;
  const all = store.workflows();
  const workflow = query.get("workflow") || null;
  if (workflow && !all.some((w) => w.name === workflow)) {
    throw new HttpError(404, "No such workflow.");
  }

  const workflows = workflow ? all.filter((w) => w.name === workflow) : all;
  const outcomes = store.outcomes(from, now, workflow);
  const calls = store.calls(from, now, workflow);

  return {
    days,
    workflow,
    pricesFetchedAt: prices.fetchedAt,
    workflowNames: all.map((w) => w.name),
    summary: summarise(workflows, outcomes, calls, from, now),
    workflows: workflows.map((w) => ({
      ...w,
      summary: summarise(
        [w],
        outcomes.filter((o) => o.workflow === w.name),
        calls,
        from,
        now,
      ),
    })),
    models: compareModels(workflows, outcomes, calls),
    weekly: weekly(outcomes),
    outcomes: store.list(from, now, workflow, LIST_LIMIT),
  };
}

export function createApp(store: Store, prices: PriceBook, clock: () => number = Date.now): Server {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Blocks DNS rebinding: another site's hostname pointed at this machine.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new HttpError(403, "Only local requests are allowed.");
    }

    const url = URL.parse(req.url ?? "/", "http://localhost");
    if (!url) throw new HttpError(400, "Not a valid address.");
    const path = url.pathname;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };

    if (req.method === "GET" && Object.hasOwn(FILES, path)) {
      const [file, type] = FILES[path]!;
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      return;
    }

    if (req.method === "GET" && path === "/api/report") {
      return send(200, report(store, prices, url.searchParams, clock()));
    }

    if (req.method === "POST" && path === "/api/log") {
      const body = await readBody(req);
      const outcome = {
        id: text(body, "outcomeId", 100),
        workflow: text(body, "workflow", 100),
        ref: optionalText(body, "ref", 200),
      };
      const call = parseCall(body.call, prices);
      store.log(outcome, call, parseTime(body, clock()));
      return send(201, { cost: call?.cost ?? null });
    }

    if (req.method === "POST" && path === "/api/review") {
      const body = await readBody(req);
      const status = text(body, "status", 20);
      if (!STATUSES.includes(status)) throw new HttpError(400, "Unknown status.");
      const review = {
        status: status as Status,
        reviewMinutes: amount(body, "reviewMinutes", 10_000),
        reworkMinutes: amount(body, "reworkMinutes", 10_000),
      };
      if (status === "accepted" && review.reworkMinutes > 0) {
        throw new HttpError(400, "An outcome that needed fixing is reworked, not accepted.");
      }
      if (!store.review(text(body, "outcomeId", 100), review)) {
        throw new HttpError(404, "No such outcome.");
      }
      return send(200, {});
    }

    if (req.method === "POST" && path === "/api/workflow") {
      const body = await readBody(req);
      const updated = store.setWorkflow(text(body, "name", 100), {
        valuePerOutcome: optionalAmount(body, "valuePerOutcome", 1e9),
        hourlyRate: optionalAmount(body, "hourlyRate", 1e6),
        fixedMonthly: amount(body, "fixedMonthly", 1e9),
      });
      if (!updated) throw new HttpError(404, "No such workflow.");
      return send(200, {});
    }

    throw new HttpError(404, "Not found.");
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status =
        error instanceof HttpError ? error.status : error instanceof ConflictError ? 409 : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return void res.end();
      const message = status === 500 ? "Something went wrong." : (error as Error).message;
      res.writeHead(status, {
        "content-type": "application/json",
        // The rest of an oversized upload is never read, so drop the connection.
        ...(status === 413 ? { connection: "close" } : {}),
      });
      res.end(JSON.stringify({ error: message }));
    });
  });
}

export function listen(store: Store, port: number) {
  const server = createApp(store, loadPrices());
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is in use. Set PORT to use another one.`
        : error,
    );
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => console.log(`Yieldlog: http://localhost:${port}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path =
    process.env.YIELDLOG_DB ?? fileURLToPath(new URL("../yieldlog.db", import.meta.url));
  listen(new Store(path), Number(process.env.PORT ?? 4600));
}
