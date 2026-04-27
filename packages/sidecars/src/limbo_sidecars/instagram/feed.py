"""Instagram Feed sidecar — JSON-RPC handlers and entrypoint.

Instagrapi is an optional dependency (``instagram`` extra). It is never
imported at module level here so that the stdlib-only unit tests can import
this module without instagrapi installed.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Optional

from limbo_sidecars.instagram.session import IGSession


def build_handlers(
    session: IGSession, *, target_username: str
) -> dict[str, Callable]:
    """Return JSON-RPC handler dict for the instagram-feed sidecar.

    Handlers:
        validate(_p)    -- serialize session.validate() -> LoginResult
        login(p)        -- p = {"username": str, "password": str}
        login_2fa(p)    -- p = {"code": str}; reuses remembered credentials
        feed/list(_p)   -- fetch latest 20 feed posts for target_username
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

    def feed_list(_p: Any) -> dict[str, Any]:
        client = session.client
        user_id = client.user_id_from_username(target_username)
        posts = client.user_feed(user_id, amount=20)
        items = [
            {
                "pk": str(p.pk),
                "code": str(p.code),
                "author": str(p.user.username),
                "caption": str(p.caption_text or ""),
                "url": f"https://www.instagram.com/p/{p.code}/",
            }
            for p in posts
        ]
        return {"items": items}

    return {
        "validate": validate,
        "login": login,
        "login_2fa": login_2fa,
        "feed/list": feed_list,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars instagram-feed``."""
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
    target_username = os.environ.get("LIMBO_IG_USERNAME", "")

    client = Client()
    session = IGSession(
        client=client,
        session_path=session_path,
        two_factor_exc=TwoFactorRequired,
    )

    handlers = build_handlers(session, target_username=target_username)

    result = session.validate()
    if result.status == "ready":
        jsonrpc.notify("body/update", {"text": "logged in"})
    else:
        jsonrpc.notify("body/update", {"text": "login required"})

    jsonrpc.serve(handlers)
    return 0
