/**
 * Copy this file into an app to log its AI calls. It has no dependencies.
 *
 * Logging never throws and gives up after a second, so a stopped tracker can't
 * break the app. Await the calls in serverless code, or they may be cut off.
 */

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

let warned = false;

export async function startOutcome(options: {
  workflow: string;
  /** A short label to recognise it by when reviewing. Don't put personal data here. */
  ref?: string;
  url?: string;
}): Promise<OutcomeLog> {
  const { workflow, ref, url = "http://localhost:4600" } = options;
  const id = crypto.randomUUID();

  const send = async (call?: LoggedCall & { id: string }) => {
    try {
      const response = await fetch(`${url}/api/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcomeId: id, workflow, ref, call }),
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      if (!warned) console.warn("Yieldlog is not recording:", error);
      warned = true;
    }
  };

  await send();
  return { id, logCall: (call) => send({ ...call, id: crypto.randomUUID() }) };
}
