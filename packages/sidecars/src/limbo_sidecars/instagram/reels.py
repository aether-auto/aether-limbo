"""Instagram Reels sidecar — JSON-RPC handlers and entrypoint.

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
    """Return JSON-RPC handler dict for the instagram-reels sidecar.

    Handlers:
        validate(_p)    -- serialize session.validate() -> LoginResult
        login(p)        -- p = {"username": str, "password": str}
        login_2fa(p)    -- p = {"code": str}; reuses remembered credentials
        media/list(_p)  -- fetch latest 20 reels for target_username
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

    def media_list(_p: Any) -> dict[str, Any]:
        client = session.client
        user_id = client.user_id_from_username(target_username)
        clips = client.user_clips(user_id, amount=20)
        items = [
            {
                "pk": str(c.pk),
                "code": str(c.code),
                "caption": str(c.caption_text or ""),
                "url": f"https://www.instagram.com/reel/{c.code}/",
            }
            for c in clips
        ]
        return {"items": items}

    return {
        "validate": validate,
        "login": login,
        "login_2fa": login_2fa,
        "media/list": media_list,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars instagram-reels``."""
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
        jsonrpc.notify("body/update", {"lines": ["instagram (reels): logged in"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["instagram (reels): login required"]})

    jsonrpc.serve(handlers)
    return 0
