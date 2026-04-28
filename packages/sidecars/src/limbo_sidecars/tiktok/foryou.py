"""TikTok "For You" sidecar — JSON-RPC handlers and entrypoint.

TikTokApi is an optional dependency (``tiktok`` extra). It is never imported
at module level here so that the stdlib-only unit tests can import this module
without TikTokApi installed.

Single sidecar covering the personalised For-You feed and per-video comments.
Comment handlers degrade gracefully — when TikTokApi rejects the call (rate
limit, auth issue, etc.) they return ``available: false`` instead of raising.

Refresh-on-failure (§4.9 carry-over):
    When ``LIMBO_TIKTOK_REFRESH_ON_FAILURE=1`` is set in the environment,
    the first auth-like exception from ``feed/list`` triggers a single
    transparent retry: the handler re-reads ``LIMBO_TIKTOK_MS_TOKEN`` from
    env, calls ``create_sessions`` to establish a fresh session, then retries
    the feed call once.  On retry success the result is returned normally; on
    retry failure the existing token-form fallback path is used.  The guard
    ``_refreshed_once_for_session`` prevents a second retry within the same
    handler-set lifetime.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

from limbo_sidecars.tiktok.session import LoginResult, Runner, TikTokSession


async def _take_async(aiter: Any, n: int) -> list[Any]:
    """Consume up to *n* items from an async iterator, returning a list."""
    result: list[Any] = []
    async for item in aiter:
        result.append(item)
        if len(result) >= n:
            break
    return result


def build_handlers(
    session: TikTokSession,
    *,
    runner: Runner = asyncio.run,
    count: int = 20,
) -> dict[str, Callable[..., Any]]:
    """Return JSON-RPC handler dict for the ``tiktok-foryou`` sidecar.

    Handlers:
        validate(_p)              -- serialize session.validate() -> LoginResult
        set_token(p)              -- p = {"ms_token": str}
        feed/list(_p)             -- fetch first ``count`` For-You feed videos
        feed/comments(p)          -- p = {"video_id": str}; degrade on failure
    """
    # Refresh-on-failure flag: read once at handler-set construction time so
    # that the env var is stable for the lifetime of this sidecar process.
    _refresh_enabled: bool = os.environ.get("LIMBO_TIKTOK_REFRESH_ON_FAILURE", "") == "1"
    # Per-session guard: allow at most one transparent retry per handler-set.
    # Stored as a mutable container so the nested closure can mutate it.
    _refresh_state: dict[str, bool] = {"attempted": False}

    def _serialize(result: LoginResult) -> dict[str, Any]:
        return {"status": result.status, "message": result.message}

    def _run(coro: Awaitable[Any]) -> Any:
        return runner(coro)

    def validate(_p: Any) -> dict[str, Any]:
        return _serialize(session.validate())

    def set_token(p: Any) -> dict[str, Any]:
        token: str = p["ms_token"]
        return _serialize(session.set_token(token))

    def _video_to_item(video: Any) -> dict[str, Any]:
        vid_id = str(getattr(video, "id", "") or "")
        author = str(getattr(video.author, "username", "") or "") if getattr(video, "author", None) is not None else ""
        caption = str(getattr(video, "desc", "") or "")
        url = (
            f"https://www.tiktok.com/@{author}/video/{vid_id}"
            if author and vid_id
            else ""
        )
        return {"id": vid_id, "author": author, "caption": caption, "url": url}

    def _fetch_feed() -> list[Any]:
        """Run the feed async call and return raw video objects."""
        api = session.client
        return _run(_take_async(api.user.feed(), count))  # type: ignore[attr-defined]

    def feed_list(_p: Any) -> dict[str, Any]:
        try:
            videos = _fetch_feed()
            return {"items": [_video_to_item(v) for v in videos]}
        except Exception:  # noqa: BLE001 — any failure is treated as auth-like
            # Refresh-on-failure path: attempt once per session when enabled.
            if _refresh_enabled and not _refresh_state["attempted"]:
                _refresh_state["attempted"] = True
                # Re-read token from env — the host may have updated secrets.toml
                # and pushed the new value into the env before or during this call.
                fresh_token = os.environ.get("LIMBO_TIKTOK_MS_TOKEN", "")
                try:
                    _run(
                        session.client.create_sessions(  # type: ignore[attr-defined]
                            ms_tokens=[fresh_token], num_sessions=1
                        )
                    )
                    videos = _fetch_feed()
                    return {"items": [_video_to_item(v) for v in videos]}
                except Exception:  # noqa: BLE001 — retry also failed; fall through
                    pass
            # Fallback: surface the token form via the "failed" validate path.
            return _serialize(LoginResult(status="failed", message="feed unavailable"))

    def _comment_to_item(c: Any) -> dict[str, Any]:
        from_user = str(getattr(c.author, "username", "") or "") if getattr(c, "author", None) is not None else ""
        text = str(getattr(c, "text", "") or "")
        return {"from": from_user, "text": text}

    def feed_comments(p: Any) -> dict[str, Any]:
        video_id: str = p["video_id"]
        try:
            api = session.client
            video = api.video(id=video_id)  # type: ignore[attr-defined]
            comments = _run(_take_async(video.comments(), count))
            return {
                "available": True,
                "items": [_comment_to_item(c) for c in comments],
            }
        except Exception as err:  # noqa: BLE001 — rate-limit degradation
            return {"available": False, "items": [], "message": str(err)}

    return {
        "validate": validate,
        "set_token": set_token,
        "feed/list": feed_list,
        "feed/comments": feed_comments,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars tiktok-foryou``."""
    from TikTokApi import TikTokApi  # type: ignore[import-untyped]

    from limbo_sidecars import jsonrpc

    session_path = (
        Path.home()
        / ".local" / "share" / "aether-limbo" / "sessions" / "tiktok.json"
    )

    api = TikTokApi()
    session = TikTokSession(client=api, session_path=session_path)
    handlers = build_handlers(session)

    result = session.validate()
    if result.status == "ready":
        jsonrpc.notify("body/update", {"lines": ["tiktok: logged in"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["tiktok: ms_token required"]})

    jsonrpc.serve(handlers)
    return 0
