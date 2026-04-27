"""X / Twitter "home" sidecar — JSON-RPC handlers and entrypoint.

twikit is an optional dependency (``twitter`` extra). It is never imported at
module level here so that the stdlib-only unit tests can import this module
without twikit installed.

Single sidecar covering both the home timeline and DMs (per §4.5 the X tab is
not split). DM handlers degrade gracefully — when twikit / X reject the call
(paid-tier endpoint, unverified app, etc.) they return ``available: false``
instead of raising.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from limbo_sidecars.twitter.session import LoginResult, Runner, TwitterSession


def build_handlers(
    session: TwitterSession,
    *,
    runner: Runner = asyncio.run,
    timeline_count: int = 20,
) -> dict[str, Callable]:
    """Return JSON-RPC handler dict for the ``twitter-home`` sidecar.

    Handlers:
        validate(_p)          -- serialize session.validate() -> LoginResult
        login(p)              -- p = {"username": str, "password": str}
        login_2fa(p)          -- p = {"code": str}; reuses remembered creds
        timeline/list(_p)     -- fetch latest ``timeline_count`` home tweets
        timeline/like(p)      -- p = {"tweet_id": str}
        timeline/reply(p)     -- p = {"tweet_id": str, "text": str}
        dms/threads(_p)       -- list DM inbox; degrade if unavailable
        dms/messages(p)       -- p = {"thread_id": str}; degrade if unavailable
    """
    _remembered: dict[str, Optional[str]] = {"username": None, "password": None}

    def _serialize(result: LoginResult) -> dict[str, Any]:
        return {"status": result.status, "message": result.message}

    def _run(coro: Awaitable[Any]) -> Any:
        return runner(coro)

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

    def _tweet_to_item(t: Any) -> dict[str, Any]:
        author = str(getattr(t.user, "screen_name", "") or "")
        text = str(getattr(t, "text", "") or "")
        tweet_id = str(getattr(t, "id", "") or "")
        url = (
            f"https://x.com/{author}/status/{tweet_id}"
            if author and tweet_id
            else ""
        )
        return {"id": tweet_id, "author": author, "text": text, "url": url}

    def timeline_list(_p: Any) -> dict[str, Any]:
        client = session.client
        tweets = _run(client.get_home_timeline(count=timeline_count))  # type: ignore[attr-defined]
        return {"items": [_tweet_to_item(t) for t in tweets]}

    def timeline_like(p: Any) -> dict[str, Any]:
        tweet_id: str = p["tweet_id"]
        try:
            _run(session.client.favorite_tweet(tweet_id))  # type: ignore[attr-defined]
            return {"ok": True, "message": None}
        except Exception as err:  # noqa: BLE001 — protocol boundary
            return {"ok": False, "message": str(err)}

    def timeline_reply(p: Any) -> dict[str, Any]:
        tweet_id: str = p["tweet_id"]
        text: str = p["text"]
        try:
            _run(
                session.client.create_tweet(  # type: ignore[attr-defined]
                    text=text, reply_to=tweet_id
                )
            )
            return {"ok": True, "message": None}
        except Exception as err:  # noqa: BLE001 — protocol boundary
            return {"ok": False, "message": str(err)}

    def _dm_thread_to_item(t: Any) -> dict[str, Any]:
        thread_id = str(getattr(t, "id", ""))
        title = str(getattr(t, "name", "") or getattr(t, "screen_name", ""))
        last = str(getattr(t, "last_message_text", "") or "")
        return {"thread_id": thread_id, "title": title, "last_message": last}

    def dms_threads(_p: Any) -> dict[str, Any]:
        try:
            threads = _run(session.client.get_dm_threads())  # type: ignore[attr-defined]
            return {
                "available": True,
                "items": [_dm_thread_to_item(t) for t in threads],
            }
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            return {"available": False, "items": [], "message": str(err)}

    def _dm_message_to_item(m: Any) -> dict[str, Any]:
        return {
            "from": str(getattr(m, "sender_id", "") or ""),
            "text": str(getattr(m, "text", "") or ""),
            "ts": str(getattr(m, "timestamp", "") or ""),
        }

    def dms_messages(p: Any) -> dict[str, Any]:
        thread_id: str = p["thread_id"]
        try:
            messages = _run(
                session.client.get_dm_messages(thread_id)  # type: ignore[attr-defined]
            )
            return {
                "available": True,
                "items": [_dm_message_to_item(m) for m in messages],
            }
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            return {"available": False, "items": [], "message": str(err)}

    return {
        "validate": validate,
        "login": login,
        "login_2fa": login_2fa,
        "timeline/list": timeline_list,
        "timeline/like": timeline_like,
        "timeline/reply": timeline_reply,
        "dms/threads": dms_threads,
        "dms/messages": dms_messages,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars twitter-home``."""
    from twikit import Client  # type: ignore[import-untyped]

    from limbo_sidecars import jsonrpc

    session_path = (
        Path.home()
        / ".local"
        / "share"
        / "aether-limbo"
        / "sessions"
        / "twitter.json"
    )

    language = os.environ.get("LIMBO_TWITTER_LANG", "en-US")
    client = Client(language=language)
    session = TwitterSession(client=client, session_path=session_path)
    handlers = build_handlers(session)

    result = session.validate()
    if result.status == "ready":
        jsonrpc.notify("body/update", {"lines": ["x: logged in"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["x: login required"]})

    jsonrpc.serve(handlers)
    return 0
