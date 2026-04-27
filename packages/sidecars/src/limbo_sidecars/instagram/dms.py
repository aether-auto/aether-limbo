"""Instagram DMs sidecar — JSON-RPC handlers and entrypoint.

Instagrapi is an optional dependency (``instagram`` extra). It is never
imported at module level here so that the stdlib-only unit tests can import
this module without instagrapi installed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional

from limbo_sidecars.instagram.session import IGSession


def build_handlers(session: IGSession) -> dict[str, Callable]:
    """Return JSON-RPC handler dict for the instagram-dms sidecar.

    Handlers:
        validate(_p)      -- serialize session.validate() -> LoginResult
        login(p)          -- p = {"username": str, "password": str}
        login_2fa(p)      -- p = {"code": str}; reuses remembered credentials
        dms/threads(_p)   -- fetch 20 DM threads
        dms/messages(p)   -- p = {"thread_id": str}; fetch 20 messages
        dms/send(p)       -- p = {"thread_id": str, "text": str}; send reply
    """
    _remembered: dict[str, Optional[str]] = {"username": None, "password": None}

    def _serialize(result: Any) -> dict[str, Any]:
        return {"status": result.status, "message": result.message}

    def validate(_p: Any) -> dict[str, Any]:
        return _serialize(session.validate())

    def login(p: Any) -> dict[str, Any]:
        username: str = p["username"]
        password: str = p["password"]
        _remembered["username"] = username
        _remembered["password"] = password
        return _serialize(session.login(username=username, password=password))

    def login_2fa(p: Any) -> dict[str, Any]:
        code: str = p["code"]
        return _serialize(
            session.login(
                username=_remembered["username"] or "",
                password=_remembered["password"] or "",
                code=code,
            )
        )

    def dms_threads(_p: Any) -> dict[str, Any]:
        client = session.client
        threads = client.direct_threads(amount=20)  # type: ignore[attr-defined]
        items = []
        for t in threads:
            users = t.users
            if len(users) == 1:
                title = str(users[0].username)
            else:
                title = "Group"
            messages = t.messages
            last_message = str(messages[0].text) if messages else ""
            items.append({
                "thread_id": str(t.id),
                "title": title,
                "last_message": last_message,
            })
        return {"items": items}

    def dms_messages(p: Any) -> dict[str, Any]:
        client = session.client
        thread_id: str = p["thread_id"]
        messages = client.direct_messages(thread_id, amount=20)  # type: ignore[attr-defined]
        items = [
            {
                "from": str(m.user_id),
                "text": str(m.text),
                "ts": str(m.timestamp),
            }
            for m in messages
        ]
        return {"items": items}

    def dms_send(p: Any) -> dict[str, Any]:
        client = session.client
        thread_id: str = p["thread_id"]
        text: str = p["text"]
        try:
            client.direct_send(text, thread_ids=[thread_id])  # type: ignore[attr-defined]
            return {"ok": True, "message": None}
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "message": str(err)}

    return {
        "validate": validate,
        "login": login,
        "login_2fa": login_2fa,
        "dms/threads": dms_threads,
        "dms/messages": dms_messages,
        "dms/send": dms_send,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars instagram-dms``."""
    from instagrapi import Client  # type: ignore[import-untyped]
    from instagrapi.exceptions import TwoFactorRequired  # type: ignore[import-untyped]

    from limbo_sidecars import jsonrpc

    session_path = (
        Path.home()
        / ".local"
        / "share"
        / "aether-limbo"
        / "sessions"
        / "instagram.json"
    )

    client = Client()
    session = IGSession(
        client=client,
        session_path=session_path,
        two_factor_exc=TwoFactorRequired,
    )

    handlers = build_handlers(session)

    result = session.validate()
    if result.status == "ready":
        jsonrpc.notify("body/update", {"lines": ["instagram (dms): logged in"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["instagram (dms): login required"]})

    jsonrpc.serve(handlers)
    return 0
