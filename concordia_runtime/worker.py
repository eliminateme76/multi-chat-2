"""Persistent JSONL worker. Model sampling is a reverse RPC to the Node owner."""

from __future__ import annotations

import json
import sys
import traceback
import uuid
from collections.abc import Mapping
from typing import Any

from . import ENGINE_NAME, ENGINE_VERSION
from .runtime import run_character, run_game_master


def _write(message: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _read() -> Mapping[str, Any] | None:
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


class NodeBridge:
    def sample(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        callback_id = f"callback-{uuid.uuid4()}"
        _write({"id": callback_id, "method": "model/sample", "params": request})
        while True:
            response = _read()
            if response is None:
                raise RuntimeError("Node model bridge disconnected.")
            if response.get("id") != callback_id:
                raise RuntimeError("Unexpected message while awaiting model callback.")
            if response.get("error"):
                raise RuntimeError(str(response["error"].get("message") or "Model callback failed."))
            return response["result"]


def dispatch(method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
    if method == "health":
        return {"status": "ready", "engine": ENGINE_NAME, "version": ENGINE_VERSION}
    bridge = NodeBridge()
    if method == "entity/act":
        return run_character(params, bridge)
    if method == "gm/judge":
        return run_game_master(params, bridge)
    raise ValueError(f"Unknown Concordia worker method: {method}")


def main() -> None:
    while True:
        request = _read()
        if request is None:
            return
        request_id = request.get("id")
        try:
            result = dispatch(str(request.get("method") or ""), request.get("params") or {})
            _write({"id": request_id, "result": result})
        except Exception as error:  # worker boundary must return a structured failure
            _write(
                {
                    "id": request_id,
                    "error": {
                        "message": str(error),
                        "type": type(error).__name__,
                        "trace": traceback.format_exc(limit=8),
                    },
                }
            )


if __name__ == "__main__":
    main()
