"""Tests for the feed/thumbnail handler in the Instagram bundle sidecar."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from limbo_sidecars.instagram.bundle import _LRUCache, build_handlers
from limbo_sidecars.instagram.session import IGSession


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class TwoFactor(Exception):
    pass


class FakeMedia:
    def __init__(
        self,
        pk: str = "1",
        thumbnail_url: str = "http://example.com/thumb.jpg",
    ) -> None:
        self.pk = pk
        self.thumbnail_url = thumbnail_url
        self.resources: list[Any] = []


class FakeClient:
    def __init__(self, media: FakeMedia | None = None) -> None:
        self._media = media or FakeMedia()
        self.username_seen: str | None = None
        self.user_id_from_username_calls: list[str] = []

    def load_settings(self, path: Path) -> None: ...

    def dump_settings(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"sessionid": "fake"}')

    def login(self, username: str, password: str, verification_code: str | None = None) -> bool:
        self.username_seen = username
        return True

    def get_timeline_feed(self) -> Any:
        return {}

    def user_id_from_username(self, name: str) -> str:
        self.user_id_from_username_calls.append(name)
        return name + "_pk"

    def user_feed(self, user_id: str, amount: int = 0) -> list[Any]:
        return [
            SimpleNamespace(
                pk="1",
                code="f1",
                caption_text="feed post",
                user=SimpleNamespace(username="alice"),
            )
        ]

    def media_info(self, media_id: str) -> FakeMedia:
        return self._media


def _make_session(tmp_path: Path, media: FakeMedia | None = None) -> IGSession:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient(media=media)
    return IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactor)


# ---------------------------------------------------------------------------
# _LRUCache unit tests
# ---------------------------------------------------------------------------


def test_lru_cache_basic_put_and_get() -> None:
    cache = _LRUCache(3)
    cache.put("a", 1)
    assert cache.get("a") == 1
    assert cache.get("b") is None


def test_lru_cache_evicts_oldest_entry() -> None:
    cache = _LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)  # evicts "a"
    assert cache.get("a") is None
    assert cache.get("b") == 2
    assert cache.get("c") == 3


def test_lru_cache_get_promotes_entry() -> None:
    cache = _LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.get("a")  # promote "a" to most-recent
    cache.put("c", 3)  # evicts "b" (least-recently-used)
    assert cache.get("a") == 1
    assert cache.get("b") is None
    assert cache.get("c") == 3


def test_lru_cache_contains() -> None:
    cache = _LRUCache(2)
    cache.put("x", 99)
    assert "x" in cache
    assert "y" not in cache


# ---------------------------------------------------------------------------
# feed/thumbnail handler — shape tests
# ---------------------------------------------------------------------------


def test_feed_thumbnail_method_present(tmp_path: Path) -> None:
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")
    assert "feed/thumbnail" in h


def test_feed_thumbnail_chafa_not_installed(tmp_path: Path) -> None:
    """When chafa is not on PATH, handler returns ok=False with a clear message."""
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")

    fake_resp = MagicMock()
    fake_resp.read.return_value = b"\xff\xd8\xff"  # fake JPEG bytes

    with (
        patch("urllib.request.urlopen", return_value=fake_resp),
        patch("subprocess.run", side_effect=FileNotFoundError("chafa not found")),
    ):
        result = h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3})

    assert result["ok"] is False
    assert "chafa not installed" in result["message"]


def test_feed_thumbnail_chafa_nonzero_exit(tmp_path: Path) -> None:
    """When chafa exits non-zero, handler returns ok=False with stderr snippet."""
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")

    fake_resp = MagicMock()
    fake_resp.read.return_value = b"\xff\xd8\xff"

    fake_proc = MagicMock()
    fake_proc.returncode = 1
    fake_proc.stdout = b""
    fake_proc.stderr = b"chafa: invalid format"

    with (
        patch("urllib.request.urlopen", return_value=fake_resp),
        patch("subprocess.run", return_value=fake_proc),
    ):
        result = h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3})

    assert result["ok"] is False
    assert "chafa: invalid format" in result["message"]


def test_feed_thumbnail_fetch_failure(tmp_path: Path) -> None:
    """When the image URL fetch fails, handler returns ok=False."""
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")

    import urllib.error

    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.URLError("connection refused"),
    ):
        result = h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3})

    assert result["ok"] is False
    assert "fetch failed" in result["message"]


def test_feed_thumbnail_success_returns_base64(tmp_path: Path) -> None:
    """Happy path: returns ok=True with base64-encoded chafa output."""
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")

    fake_chafa_output = b"\x1b[1;1H[img]\x1b[0m"

    fake_resp = MagicMock()
    fake_resp.read.return_value = b"\xff\xd8\xff"

    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = fake_chafa_output
    fake_proc.stderr = b""

    with (
        patch("urllib.request.urlopen", return_value=fake_resp),
        patch("subprocess.run", return_value=fake_proc),
    ):
        result = h["feed/thumbnail"](
            {"media_id": "1", "cols": 12, "rows": 3, "format": "symbols"}
        )

    assert result["ok"] is True
    assert result["format"] == "symbols"
    decoded = base64.b64decode(result["encoded"])
    assert decoded == fake_chafa_output


def test_feed_thumbnail_cache_hit_skips_fetch(tmp_path: Path) -> None:
    """Second call with identical params hits cache without re-fetching."""
    cache = _LRUCache(32)
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice", _thumbnail_cache=cache)

    fake_chafa_output = b"[ascii art]"
    fake_resp = MagicMock()
    fake_resp.read.return_value = b"\xff\xd8\xff"

    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = fake_chafa_output
    fake_proc.stderr = b""

    with (
        patch("urllib.request.urlopen", return_value=fake_resp) as mock_url,
        patch("subprocess.run", return_value=fake_proc) as mock_run,
    ):
        result1 = h["feed/thumbnail"](
            {"media_id": "1", "cols": 12, "rows": 3, "format": "symbols"}
        )
        result2 = h["feed/thumbnail"](
            {"media_id": "1", "cols": 12, "rows": 3, "format": "symbols"}
        )

    # Both should succeed
    assert result1["ok"] is True
    assert result2["ok"] is True
    # fetch and chafa should only have been called once
    assert mock_url.call_count == 1
    assert mock_run.call_count == 1


def test_feed_thumbnail_cache_miss_on_different_format(tmp_path: Path) -> None:
    """Different format key → different cache entry, so fetch+render twice."""
    cache = _LRUCache(32)
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice", _thumbnail_cache=cache)

    fake_resp = MagicMock()
    fake_resp.read.return_value = b"\xff\xd8\xff"

    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = b"output"
    fake_proc.stderr = b""

    with (
        patch("urllib.request.urlopen", return_value=fake_resp) as mock_url,
        patch("subprocess.run", return_value=fake_proc) as mock_run,
    ):
        h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3, "format": "symbols"})
        h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3, "format": "kitty"})

    assert mock_url.call_count == 2
    assert mock_run.call_count == 2


def test_feed_thumbnail_no_thumbnail_url(tmp_path: Path) -> None:
    """When media has no thumbnail_url, returns ok=False."""
    media = FakeMedia(thumbnail_url="")
    sess = _make_session(tmp_path, media=media)
    h = build_handlers(sess, target_username="alice")

    result = h["feed/thumbnail"]({"media_id": "1", "cols": 12, "rows": 3})
    assert result["ok"] is False
    assert "no thumbnail_url" in result["message"]


def test_bundle_exports_feed_thumbnail_method(tmp_path: Path) -> None:
    """bundle.build_handlers must export feed/thumbnail alongside existing methods."""
    sess = _make_session(tmp_path)
    h = build_handlers(sess, target_username="alice")
    expected = {
        "validate",
        "login",
        "login_2fa",
        "media/list",
        "feed/list",
        "feed/thumbnail",
        "dms/threads",
        "dms/messages",
        "dms/send",
    }
    assert set(h.keys()) == expected
