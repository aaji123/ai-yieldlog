/**
 * Imports Claude Code sessions from this computer. One session becomes one outcome.
 *
 * Only token counts, model names, times and folder names are kept. Session titles
 * are written from the conversation, so they are kept only with --titles.
 */
import { createReadStream, globSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { costOf, loadPrices, normaliseUsage, type PriceBook } from "./pricing.ts";
import { databasePath, Store, type LogEntry } from "./store.ts";

export const WORKFLOW_PREFIX = "Claude Code: ";

/** A call without an end may still be running, so it's left for the next import. */
const STILL_RUNNING = 10 * 60_000;

type Json = Record<string, unknown>;

type Message = { model: string; usage: unknown; at: number; finished: boolean; subagent: boolean };
type Session = { folder: string | null; title: string | null; messages: Map<string, Message> };

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function parseLine(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null; // the last line of a running session can be half written
  }
}

/** Works for Windows and Unix paths, whichever system wrote the log. */
const lastFolder = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? null;

function read(session: Session, line: Json) {
  if (line.type === "ai-title" && typeof line.aiTitle === "string") session.title = line.aiTitle;
  if (line.type !== "assistant" || !isObject(line.message)) return;

  const { id, model, usage, stop_reason } = line.message;
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  if (typeof id !== "string" || typeof model !== "string" || !isObject(usage)) return;
  // Claude Code writes error notices as messages from a model that doesn't exist.
  if (model === "<synthetic>" || Number.isNaN(at)) return;

  const subagent = line.isSidechain === true;
  if (!subagent && session.folder === null && typeof line.cwd === "string") {
    session.folder = lastFolder(line.cwd);
  }
  // One call is written once per content block, each time with the whole call's
  // usage. Counting every line would multiply the cost.
  const earlier = session.messages.get(id);
  session.messages.set(id, {
    model,
    usage,
    at: earlier?.at ?? at,
    finished: (earlier?.finished ?? false) || (stop_reason ?? null) !== null,
    subagent,
  });
}

export async function readSessions(projectsDir: string): Promise<Map<string, Session>> {
  const sessions = new Map<string, Session>();
  // <project>/<session>.jsonl, and its subagents under <project>/<session>/
  for (const file of globSync("**/*.jsonl", { cwd: projectsDir }).sort()) {
    const parts = file.split(sep);
    if (parts.length < 2) continue;
    const id = basename(parts[1]!, ".jsonl");
    const session = sessions.get(id) ?? { folder: null, title: null, messages: new Map() };
    sessions.set(id, session);
    const lines = createInterface({
      input: createReadStream(join(projectsDir, file), "utf8"),
      crlfDelay: Infinity,
    });
    for await (const text of lines) {
      const line = parseLine(text);
      if (line) read(session, line);
    }
  }
  return sessions;
}

const dateLabel = (t: number) =>
  `Session ${new Date(t).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}`;

export function toEntries(
  sessions: Map<string, Session>,
  prices: PriceBook,
  options: { titles: boolean; now: number },
): LogEntry[] {
  // A resumed session can repeat calls from the one it came from.
  const seen = new Set<string>();

  return [...sessions].flatMap(([sessionId, session]) => {
    const messages = [...session.messages]
      .filter(([, m]) => m.finished || options.now - m.at > STILL_RUNNING)
      .filter(([id]) => !seen.has(id) && seen.add(id))
      .sort(([, a], [, b]) => a.at - b.at);
    if (messages.length === 0) return [];

    const title = options.titles ? session.title?.trim().slice(0, 200) : null;
    const outcome = {
      id: `claude-code:${sessionId}`,
      workflow: (WORKFLOW_PREFIX + (session.folder ?? "unknown folder")).slice(0, 100),
      ref: title || dateLabel(messages[0]![1].at),
    };
    return messages.map(([id, m]): LogEntry => {
      const usage = normaliseUsage(m.usage);
      return {
        outcome,
        at: m.at,
        call: {
          id: `claude-code:${id}`,
          step: m.subagent ? "subagent" : null,
          model: m.model,
          usage,
          cost: costOf(prices, m.model, usage),
          latencyMs: null,
          ok: true,
        },
      };
    });
  });
}

async function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.find((f) => f !== "--titles" && f !== "--dry-run");
  if (unknown) {
    console.error(`Unknown option ${unknown}. Use --titles or --dry-run.`);
    process.exit(1);
  }

  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const sessions = await readSessions(projectsDir);
  const entries = toEntries(sessions, loadPrices(), {
    titles: flags.includes("--titles"),
    now: Date.now(),
  });
  if (entries.length === 0) {
    console.log(`No Claude Code sessions found in ${projectsDir}.`);
    return;
  }

  const total = entries.reduce((sum, e) => sum + (e.call!.cost.usd ?? 0), 0);
  const unpriced = entries.filter((e) => e.call!.cost.usd === null).length;
  console.log(
    `Found ${entries.length} calls in ${new Set(entries.map((e) => e.outcome.id)).size} sessions.`,
  );
  console.log(
    `At list prices: $${total.toFixed(2)}${unpriced ? `, plus ${unpriced} calls without a known price` : ""}.`,
  );
  console.log("With a subscription you pay its flat fee instead, so this isn't your bill.");

  if (flags.includes("--dry-run")) return console.log("Nothing was saved.");
  const store = new Store(databasePath());
  console.log(`Saved ${store.logAll(entries)} new calls. Run "npm start" to review the sessions.`);
  store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
