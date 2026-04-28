"""X / Twitter "home" sidecar — JSON-RPC handlers and entrypoint.

twikit is an optional dependency (``twitter`` extra). It is never imported at
module level here so that the stdlib-only unit tests can import this module
without twikit installed.

Single sidecar covering both the home timeline and DMs (per §4.5 the X tab is
not split). DM handlers degrade gracefully — when twikit / X reject the call
(paid-tier endpoint, unverified app, etc.) they return ``available: false``
instead of raising.

Backend selection:
    Set ``LIMBO_TWITTER_BACKEND=tweepy`` to use the TweepySession backend.
    Default (unset or ``twikit``) uses the existing TwitterSession/twikit backend.

DM availability caching (§4.11 carry-over from §4.8):
    Set ``LIMBO_TWITTER_CACHE_DMS=1`` to enable session-level DM availability
    caching.  When enabled, the first ``dms/threads`` or ``dms/messages`` call
    that returns ``available: False`` writes that result into a shared mutable
    holder (``_dms_cache``).  Subsequent calls short-circuit immediately without
    probing the underlying client, saving a round-trip to an endpoint that is
    known to be unavailable.  The cache lives in the sidecar process and is
    reset on restart.  Both twikit and tweepy backends share the same cache
    because availability is determined by the X account tier, not the client
    library.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Union

from limbo_sidecars.twitter.session import LoginResult, Runner, TwitterSession
from limbo_sidecars.twitter.tweepy_session import TweepySession

# Union type for a session accepted by build_handlers
AnyTwitterSession = Union[TwitterSession, TweepySession]


# ---------------------------------------------------------------------------
# Twikit-backed handlers
# ---------------------------------------------------------------------------

def _build_twikit_handlers(
    session: TwitterSession,
    *,
    runner: Runner,
    timeline_count: int,
    cache_dms: bool,
    dms_cache: dict[str, Optional[bool]],
) -> dict[str, Callable]:
    """Build handlers that delegate to the twikit async client."""

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
        # Cache short-circuit: if caching is enabled and we already know DMs
        # are unavailable for this session, skip the probe entirely.
        if cache_dms and dms_cache["available"] is False:
            return {"available": False, "items": [], "message": "DMs unavailable (cached)"}
        try:
            threads = _run(session.client.get_dm_threads())  # type: ignore[attr-defined]
            if cache_dms:
                dms_cache["available"] = True
            return {
                "available": True,
                "items": [_dm_thread_to_item(t) for t in threads],
            }
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            if cache_dms:
                dms_cache["available"] = False
            return {"available": False, "items": [], "message": str(err)}

    def _dm_message_to_item(m: Any) -> dict[str, Any]:
        return {
            "from": str(getattr(m, "sender_id", "") or ""),
            "text": str(getattr(m, "text", "") or ""),
            "ts": str(getattr(m, "timestamp", "") or ""),
        }

    def dms_messages(p: Any) -> dict[str, Any]:
        thread_id: str = p["thread_id"]
        # Cache short-circuit: same logic as dms_threads.
        if cache_dms and dms_cache["available"] is False:
            return {"available": False, "items": [], "message": "DMs unavailable (cached)"}
        try:
            messages = _run(
                session.client.get_dm_messages(thread_id)  # type: ignore[attr-defined]
            )
            if cache_dms:
                dms_cache["available"] = True
            return {
                "available": True,
                "items": [_dm_message_to_item(m) for m in messages],
            }
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            if cache_dms:
                dms_cache["available"] = False
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


# ---------------------------------------------------------------------------
# Tweepy-backed handlers
# ---------------------------------------------------------------------------

def _build_tweepy_handlers(
    session: TweepySession,
    *,
    timeline_count: int,
    cache_dms: bool,
    dms_cache: dict[str, Optional[bool]],
) -> dict[str, Callable]:
    """Build handlers that delegate to TweepySession's synchronous methods."""

    def validate(_p: Any) -> dict[str, Any]:
        return session.validate()

    def login(p: Any) -> dict[str, Any]:
        username: str = p.get("username", "")
        password: str = p.get("password", "")
        return session.login(username=username, password=password)

    def login_2fa(p: Any) -> dict[str, Any]:
        code: str = p.get("code", "")
        return session.login_2fa(code=code)

    def timeline_list(_p: Any) -> dict[str, Any]:
        items = session.home_timeline(limit=timeline_count)
        return {"items": items}

    def timeline_like(p: Any) -> dict[str, Any]:
        tweet_id: str = p["tweet_id"]
        result = session.like(tweet_id)
        # Normalise to match twikit shape: always include "message" key
        if "message" not in result:
            result["message"] = None
        return result

    def timeline_reply(p: Any) -> dict[str, Any]:
        tweet_id: str = p["tweet_id"]
        text: str = p["text"]
        result = session.reply(tweet_id=tweet_id, text=text)
        if "message" not in result:
            result["message"] = None
        return result

    def dms_threads(_p: Any) -> dict[str, Any]:
        # Cache short-circuit: if caching is enabled and we already know DMs
        # are unavailable for this session, skip the probe entirely.
        if cache_dms and dms_cache["available"] is False:
            return {"available": False, "items": [], "message": "DMs unavailable (cached)"}
        result = session.dm_threads()
        if cache_dms:
            dms_cache["available"] = result.get("available", True)
        return result

    def dms_messages(p: Any) -> dict[str, Any]:
        thread_id: str = p["thread_id"]
        # Cache short-circuit: same logic as dms_threads.
        if cache_dms and dms_cache["available"] is False:
            return {"available": False, "items": [], "message": "DMs unavailable (cached)"}
        result = session.dm_messages(thread_id=thread_id)
        if cache_dms:
            dms_cache["available"] = result.get("available", True)
        return result

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


# ---------------------------------------------------------------------------
# Public factory — dispatches to the right set of handlers based on session type
# ---------------------------------------------------------------------------

def build_handlers(
    session: AnyTwitterSession,
    *,
    runner: Runner = asyncio.run,
    timeline_count: int = 20,
    cache_dms: Optional[bool] = None,
) -> dict[str, Callable]:
    """Return JSON-RPC handler dict for the ``twitter-home`` sidecar.

    Handlers:
        validate(_p)          -- serialize session.validate() -> LoginResult / dict
        login(p)              -- p = {"username": str, "password": str}
        login_2fa(p)          -- p = {"code": str}; reuses remembered creds (twikit)
                                 or no-op ok (tweepy)
        timeline/list(_p)     -- fetch latest ``timeline_count`` home tweets
        timeline/like(p)      -- p = {"tweet_id": str}
        timeline/reply(p)     -- p = {"tweet_id": str, "text": str}
        dms/threads(_p)       -- list DM inbox; degrade if unavailable
        dms/messages(p)       -- p = {"thread_id": str}; degrade if unavailable

    Args:
        cache_dms: Override the ``LIMBO_TWITTER_CACHE_DMS`` env var.  Pass
            ``True`` / ``False`` explicitly (useful in tests); ``None`` (default)
            reads from the environment.
    """
    # Resolve DM caching flag once at construction time so it is stable for
    # the lifetime of this handler set (mirrors tiktok's _refresh_enabled pattern).
    if cache_dms is None:
        _cache_dms: bool = os.environ.get("LIMBO_TWITTER_CACHE_DMS", "") == "1"
    else:
        _cache_dms = cache_dms

    # Session-level DM availability cache.  Stored as a mutable dict so that
    # the nested closures inside both backend builders can read and write it
    # without a ``nonlocal`` declaration (same pattern as tiktok's _refresh_state).
    # Both backends share the same dict — availability is an account-tier
    # property, not a client-library property.
    _dms_cache: dict[str, Optional[bool]] = {"available": None}

    if isinstance(session, TweepySession):
        return _build_tweepy_handlers(
            session,
            timeline_count=timeline_count,
            cache_dms=_cache_dms,
            dms_cache=_dms_cache,
        )
    return _build_twikit_handlers(
        session,
        runner=runner,
        timeline_count=timeline_count,
        cache_dms=_cache_dms,
        dms_cache=_dms_cache,
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars twitter-home``.

    Reads ``LIMBO_TWITTER_BACKEND`` (``twikit`` | ``tweepy``, default ``twikit``)
    to select the backing session implementation.
    """
    from limbo_sidecars import jsonrpc

    backend = os.environ.get("LIMBO_TWITTER_BACKEND", "twikit").lower()

    if backend == "tweepy":
        session: AnyTwitterSession = TweepySession()
        result_dict = session.validate()
        if result_dict.get("status") == "ok":
            jsonrpc.notify("body/update", {"lines": ["x: logged in (tweepy)"]})
        else:
            jsonrpc.notify("body/update", {"lines": ["x: login required (tweepy)"]})
        handlers = build_handlers(session)
    else:
        from twikit import Client  # type: ignore[import-untyped]

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
        twikit_session = TwitterSession(client=client, session_path=session_path)
        result = twikit_session.validate()
        if result.status == "ready":
            jsonrpc.notify("body/update", {"lines": ["x: logged in"]})
        else:
            jsonrpc.notify("body/update", {"lines": ["x: login required"]})
        handlers = build_handlers(twikit_session)

    jsonrpc.serve(handlers)
    return 0
