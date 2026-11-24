/**
 * Copy this file into a Node.js app to log its AI calls. It has no dependencies.
 *
 * Logging never throws. If Yieldlog can't be reached within a second, the call is
 * kept in the .yieldlog-unsent folder and sent after the next call that gets
 * through. Add that folder to .gitignore.
 *
 * Await the calls in serverless code, or they may be cut off.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LoggedCall = {
  model: string;
  /** The `usage` object from the provider's response, passed through as is. */
  usage?: unknown;
  /** Which step of the workflow this was, such as "outline". */
  step?: string;
  latencyMs?: number;
  /** False if the call failed. Failed calls still count if they cost money. */
  ok?: boolean;
};

export type OutcomeLog = { id: string; logCall: (call: LoggedCall) => Promise<void> };

type Result = "sent" | "refused" | "unreachable";

const MAX_UNSENT = 10_000;
const RESEND_AT_ONCE = 50;

async function post(url: string, body: string): Promise<Result> {
  try {
    const response = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(1000),
    });
    const detail = await response.text();
    if (response.ok) return "sent";
    if (response.status >= 500) return "unreachable";
    console.warn(`Yieldlog refused a call (HTTP ${response.status}): ${detail}`);
    return "refused"; // sending it again won't help
  } catch {
    return "unreachable";
  }
}

/** One file per call, so apps running side by side can't overwrite each other. */
async function keep(dir: string, body: string) {
  try {
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length >= MAX_UNSENT) throw new Error(`${dir} is full`);
    const path = join(dir, crypto.randomUUID());
    await writeFile(`${path}.tmp`, body);
    await rename(`${path}.tmp`, `${path}.json`); // never leaves half a file to send
    console.warn(`Yieldlog can't be reached. The call is kept in ${dir}.`);
  } catch (error) {
    console.warn("Yieldlog can't be reached and the call was LOST:", error);
  }
}

/** Two apps may send the same file. That's harmless: Yieldlog ignores repeats. */
async function resend(url: string, dir: string) {
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    for (const name of files.slice(0, RESEND_AT_ONCE)) {
      const path = join(dir, name);
      const body = await readFile(path, "utf8").catch(() => null);
      if (body === null) continue; // another app got there first
      const result = await post(url, body);
      if (result === "unreachable") return;
      if (result === "sent") await rm(path, { force: true });
      else await rename(path, `${path}.refused`).catch(() => {});
    }
  } catch {
    // No folder means nothing is waiting.
  }
}

export async function startOutcome(options: {
  workflow: string;
  /** A short label to recognise it by when reviewing. Don't put personal data here. */
  ref?: string;
  url?: string;
  unsentDir?: string;
}): Promise<OutcomeLog> {
  const { workflow, ref, url = "http://localhost:4600", unsentDir = ".yieldlog-unsent" } = options;
  const id = crypto.randomUUID();

  const send = async (call?: LoggedCall & { id: string }) => {
    let body: string;
    try {
      body = JSON.stringify({ outcomeId: id, workflow, ref, at: Date.now(), call });
    } catch (error) {
      console.warn("Yieldlog couldn't read a call, so it was LOST:", error);
      return;
    }
    const result = await post(url, body);
    if (result === "unreachable") await keep(unsentDir, body);
    if (result === "sent") await resend(url, unsentDir);
  };

  await send();
  return { id, logCall: (call) => send({ ...call, id: crypto.randomUUID() }) };
}
