"""Copy this file into a Python app to log its AI calls. It has no dependencies.

Logging never raises. If Yieldlog can't be reached within a second, the call is
kept in the .yieldlog-unsent folder and sent after the next call that gets
through. Add that folder to .gitignore.

It blocks while sending: in async code use asyncio.to_thread.
"""

import json
import logging
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_UNSENT = 10_000
RESEND_AT_ONCE = 50


class Outcome:
    """One piece of work, such as a story, and the AI calls that went into it."""

    def __init__(
        self,
        workflow: str,
        ref: str | None = None,
        url: str = "http://localhost:4600",
        unsent_dir: str = ".yieldlog-unsent",
    ) -> None:
        self.id = str(uuid.uuid4())
        self._workflow = workflow
        self._ref = ref
        self._url = url
        self._unsent = Path(unsent_dir)
        self._send(None)

    def log_call(
        self,
        model: str,
        usage: dict | None = None,
        step: str | None = None,
        latency_ms: float | None = None,
        ok: bool = True,
    ) -> None:
        """Record one call. Pass the provider's usage as a dict (SDKs: usage.model_dump())."""

        self._send(
            {
                "id": str(uuid.uuid4()),
                "model": model,
                "usage": usage,
                "step": step,
                "latencyMs": latency_ms,
                "ok": ok,
            }
        )

    def _send(self, call: dict | None) -> None:
        try:
            body = json.dumps(
                {
                    "outcomeId": self.id,
                    "workflow": self._workflow,
                    "ref": self._ref,
                    "at": int(time.time() * 1000),
                    "call": call,
                }
            ).encode()
        except (TypeError, ValueError) as error:
            logger.warning("Yieldlog couldn't read a call, so it was LOST: %s", error)
            return
        result = self._post(body)
        if result == "unreachable":
            self._keep(body)
        elif result == "sent":
            self._resend()

    def _post(self, body: bytes) -> str:
        """Return "sent", "refused" (sending again won't help) or "unreachable"."""

        try:
            request = urllib.request.Request(
                f"{self._url}/api/log", data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=1):
                return "sent"
        except urllib.error.HTTPError as error:
            with error:
                if error.code >= 500:
                    return "unreachable"
                detail = error.read(500).decode(errors="replace")
            logger.warning("Yieldlog refused a call (HTTP %d): %s", error.code, detail)
            return "refused"
        except Exception:
            return "unreachable"

    def _keep(self, body: bytes) -> None:
        """Save one file per call, so apps running side by side can't overwrite each other."""

        try:
            self._unsent.mkdir(parents=True, exist_ok=True)
            if sum(1 for _ in self._unsent.iterdir()) >= MAX_UNSENT:
                raise OSError(f"{self._unsent} is full")
            temporary = self._unsent / f"{uuid.uuid4()}.tmp"
            temporary.write_bytes(body)
            temporary.replace(temporary.with_suffix(".json"))  # never leaves half a file to send
            logger.warning("Yieldlog can't be reached. The call is kept in %s.", self._unsent)
        except Exception as error:
            logger.warning("Yieldlog can't be reached and the call was LOST: %s", error)

    def _resend(self) -> None:
        """Send kept calls. Two apps may send the same one: Yieldlog ignores repeats."""

        try:
            for path in list(self._unsent.glob("*.json"))[:RESEND_AT_ONCE]:
                try:
                    body = path.read_bytes()
                except FileNotFoundError:
                    continue  # another app got there first
                result = self._post(body)
                if result == "unreachable":
                    return
                if result == "sent":
                    path.unlink(missing_ok=True)
                else:
                    path.replace(f"{path}.refused")
        except Exception as error:
            logger.warning("Yieldlog couldn't send kept calls yet: %s", error)
