"""Instagram bundle sidecar — all three handler families behind one IGSession.

Instagrapi is an optional dependency (``instagram`` extra). It is never
imported at module level here so that the stdlib-only unit tests can import
this module without instagrapi installed.
"""
from __future__ import annotations

import base64
import os
import subprocess
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from limbo_sidecars.instagram.dms import build_handlers as _build_dms
from limbo_sidecars.instagram.feed import build_handlers as _build_feed
from limbo_sidecars.instagram.reels import build_handlers as _build_reels
from limbo_sidecars.instagram.session import IGSession

# ---------------------------------------------------------------------------
# Simple LRU cache for thumbnail renders
# ---------------------------------------------------------------------------

class _LRUCache:
    """Thread-unsafe LRU cache keyed by an arbitrary hashable."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        # OrderedDict used as ordered map: most-recent at end
        from collections import OrderedDict
        self._data: OrderedDict[Any, Any] = OrderedDict()

    def get(self, key: Any) -> Any | None:
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key: Any, value: Any) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = value
        if len(self._data) > self._capacity:
            self._data.popitem(last=False)

    def __contains__(self, key: Any) -> bool:
        return key in self._data


def build_handlers(
    session: IGSession,
    *,
    target_username: str = "",
    _thumbnail_cache: _LRUCache | None = None,
) -> dict[str, Callable]:
    """Return a merged JSON-RPC handler dict covering reels, feed, and dms.

    Shared auth handlers (validate / login / login_2fa) come from the reels
    family; all three families share the same IGSession so login state is
    unified.  The per-namespace data handlers are added on top.

    Method names (slash-separated) match what the host adapters call:
        validate, login, login_2fa
        reels/list  (alias: media/list — kept for backward compat with host)
        feed/list
        dms/threads, dms/messages, dms/send
    """
    # Thumbnail LRU cache: keyed by (media_id, cols, rows, format), capacity 32.
    _thumb_cache: _LRUCache = _thumbnail_cache if _thumbnail_cache is not None else _LRUCache(32)

    # Read graphics format from env once; default to "symbols".
    _graphics_format: str = os.environ.get("LIMBO_GRAPHICS_PROTOCOL", "symbols")
    if _graphics_format == "none":
        _graphics_format = "symbols"

    # Single remembered-credentials closure shared across all login handlers.
    _remembered: dict[str, Optional[str]] = {"username": None, "password": None}

    def _serialize(result: Any) -> dict[str, Any]:
        return {"status": result.status, "message": result.message}

    # ---------------------------------------------------------------------------
    # Shared auth handlers
    # ---------------------------------------------------------------------------

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

    # ---------------------------------------------------------------------------
    # Reels handlers (media/list)
    # ---------------------------------------------------------------------------

    def media_list(_p: Any) -> dict[str, Any]:
        client = session.client
        user_id = client.user_id_from_username(target_username)  # type: ignore[attr-defined]
        clips = client.user_clips(user_id, amount=20)  # type: ignore[attr-defined]
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

    # ---------------------------------------------------------------------------
    # Feed handlers (feed/list)
    # ---------------------------------------------------------------------------

    def feed_list(_p: Any) -> dict[str, Any]:
        client = session.client
        user_id = client.user_id_from_username(target_username)  # type: ignore[attr-defined]
        posts = client.user_feed(user_id, amount=20)  # type: ignore[attr-defined]
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

    # ---------------------------------------------------------------------------
    # Feed thumbnail handler (feed/thumbnail)
    # ---------------------------------------------------------------------------

    def feed_thumbnail(p: Any) -> dict[str, Any]:
        """Fetch a thumbnail for a media item and render it via chafa.

        Request: {media_id: str, cols: int, rows: int, format?: str}
        Response:
          {ok: true, format: str, encoded: str}  -- base64-encoded chafa output
          {ok: false, message: str}               -- on any failure
        """
        media_id: str = str(p.get("media_id", ""))
        cols: int = int(p.get("cols", 12))
        rows: int = int(p.get("rows", 3))
        fmt: str = str(p.get("format", _graphics_format))

        # Normalise: only accept known formats.
        if fmt not in ("kitty", "sixel", "symbols"):
            fmt = "symbols"

        cache_key = (media_id, cols, rows, fmt)
        cached = _thumb_cache.get(cache_key)
        if cached is not None:
            return cached

        # Resolve thumbnail_url via instagrapi.
        try:
            client = session.client
            # media_info returns a Media object with thumbnail_url attribute.
            media = client.media_info(media_id)  # type: ignore[attr-defined]
            thumbnail_url: str | None = getattr(media, "thumbnail_url", None)
            if not thumbnail_url:
                # Fallback: try resources[0].thumbnail_url for carousel/video.
                resources = getattr(media, "resources", []) or []
                if resources:
                    thumbnail_url = getattr(resources[0], "thumbnail_url", None)
            if not thumbnail_url:
                result: dict[str, Any] = {"ok": False, "message": "no thumbnail_url"}
                return result
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": f"media_info failed: {exc}"}

        # Fetch the image bytes.
        try:
            with urllib.request.urlopen(thumbnail_url, timeout=5) as resp:
                img_bytes: bytes = resp.read()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": f"fetch failed: {exc}"}

        # Shell out to chafa.
        chafa_cmd = [
            "chafa",
            f"--format={fmt}",
            "--align=top,left",
            f"-s{cols}x{rows}",
            "-",
        ]
        try:
            proc = subprocess.run(
                chafa_cmd,
                input=img_bytes,
                capture_output=True,
                timeout=10,
            )
        except FileNotFoundError:
            return {"ok": False, "message": "chafa not installed"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": f"chafa error: {exc}"}

        if proc.returncode != 0:
            stderr_short = (proc.stderr or b"").decode(errors="replace")[:200]
            return {"ok": False, "message": stderr_short}

        encoded = base64.b64encode(proc.stdout).decode("ascii")
        hit: dict[str, Any] = {"ok": True, "format": fmt, "encoded": encoded}
        _thumb_cache.put(cache_key, hit)
        return hit

    # ---------------------------------------------------------------------------
    # DMs handlers (dms/threads, dms/messages, dms/send)
    # ---------------------------------------------------------------------------

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
        "media/list": media_list,
        "feed/list": feed_list,
        "feed/thumbnail": feed_thumbnail,
        "dms/threads": dms_threads,
        "dms/messages": dms_messages,
        "dms/send": dms_send,
    }


def main() -> int:
    """Entrypoint for ``python -m limbo_sidecars instagram``."""
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
        jsonrpc.notify("body/update", {"lines": ["instagram: logged in"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["instagram: login required"]})

    jsonrpc.serve(handlers)
    return 0
