"""Echo sidecar — proves the JSON-RPC wire format end-to-end.

Methods:
  ping(params)             -> "pong"
  echo({text: str})        -> {echoed: str, count: int}

Notifications emitted at startup:
  body/update {lines: [...]}  — one-shot, paints the initial pane content.
"""
from __future__ import annotations

from typing import Any

from . import jsonrpc

_count = 0


def _ping(_params: Any) -> str:
    return "pong"


def _echo(params: Any) -> dict[str, Any]:
    global _count
    _count += 1
    text = ""
    if isinstance(params, dict):
        text = str(params.get("text", ""))
    return {"echoed": text, "count": _count}


def main() -> int:
    jsonrpc.notify(
        "body/update",
        {"lines": ["echo sidecar ready", "round-trips: 0", "press j to ping"]},
    )
    jsonrpc.serve({"ping": _ping, "echo": _echo})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
