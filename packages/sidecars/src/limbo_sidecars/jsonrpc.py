"""Minimal NDJSON-framed JSON-RPC 2.0 server. Stdlib only.

Each line on stdin is exactly one JSON-RPC envelope. Each response /
notification written to stdout ends with a single '\\n'. Anything
written to stderr is considered diagnostic noise (for users to see
if they tail it).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable, Optional, Union

METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

JsonValue = Any  # JSON values are too dynamic to type narrowly here


@dataclass
class Request:
    id: Union[int, str]
    method: str
    params: Optional[JsonValue]


@dataclass
class Notification:
    method: str
    params: Optional[JsonValue]


Handler = Callable[[Optional[JsonValue]], JsonValue]


def _write(obj: JsonValue) -> None:
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")
    sys.stdout.flush()


def respond(req_id: Union[int, str], result: JsonValue) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def respond_error(
    req_id: Union[int, str, None], code: int, message: str, data: JsonValue = None
) -> None:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    _write({"jsonrpc": "2.0", "id": req_id, "error": err})


def notify(method: str, params: JsonValue = None) -> None:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    _write(msg)


def serve(handlers: dict[str, Handler]) -> None:
    """Read stdin line-by-line, dispatch to handlers, write replies. Returns on EOF."""
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as err:
            respond_error(None, INTERNAL_ERROR, f"invalid JSON: {err}")
            continue
        if msg.get("jsonrpc") != "2.0":
            respond_error(None, INTERNAL_ERROR, "missing jsonrpc:'2.0' tag")
            continue
        method = msg.get("method")
        if method is None:
            # response from host — sidecar doesn't issue requests, so ignore
            continue
        params = msg.get("params")
        if "id" in msg:
            req_id = msg["id"]
            handler = handlers.get(method)
            if handler is None:
                respond_error(req_id, METHOD_NOT_FOUND, f"method not found: {method}")
                continue
            try:
                result = handler(params)
            except Exception as err:  # noqa: BLE001 — protocol boundary
                respond_error(req_id, INTERNAL_ERROR, str(err))
                continue
            respond(req_id, result)
        else:
            handler = handlers.get(method)
            if handler is not None:
                try:
                    handler(params)
                except Exception:  # noqa: BLE001 — silent for notifications
                    pass
