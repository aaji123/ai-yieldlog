"""Copy this file into a Python app to log its AI calls. It has no dependencies.

Logging never raises and gives up after a second, so a stopped tracker can't
break the app. It blocks while sending: in async code use asyncio.to_thread.
"""

import json
import logging
import urllib.request
import uuid

logger = logging.getLogger(__name__)


class Outcome:
    """One piece of work, such as a story, and the AI calls that went into it."""

    def __init__(self, workflow: str, ref: str | None = None, url: str = "http://localhost:4600") -> None:
        self.id = str(uuid.uuid4())
        self._workflow = workflow
        self._ref = ref
        self._url = url
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
            body = {"outcomeId": self.id, "workflow": self._workflow, "ref": self._ref, "call": call}
            request = urllib.request.Request(
                f"{self._url}/api/log",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=1):
                pass
        except Exception as error:
            logger.warning("Yieldlog is not recording: %s", error)
