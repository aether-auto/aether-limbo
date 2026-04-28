"""Tests for the tiktok-foryou sidecar handlers (no TikTokApi required)."""
from __future__ import annotations

import stat
from pathlib import Path
from typing import Any

from limbo_sidecars.tiktok.foryou import build_handlers
from limbo_sidecars.tiktok.session import LoginResult, TikTokSession


# ---------------------------------------------------------------------------
# sync_runner — drives a coroutine synchronously without opening an event loop.
# Duplicated from test_tiktok_session.py (intentional — stdlib-only tests).
# ---------------------------------------------------------------------------
def sync_runner(coro: Any) -> Any:
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value


# ---------------------------------------------------------------------------
# Fake TikTokApi client — hand-rolled, no TikTokApi package required.
# ---------------------------------------------------------------------------

class FakeAuthor:
    def __init__(self, username: str) -> None:
        self.username = username


class FakeVideo:
    def __init__(self, id: str, author: str, desc: str) -> None:
        self.id = id
        self.author = FakeAuthor(author)
        self.desc = desc


class FakeComment:
    def __init__(self, username: str, text: str) -> None:
        self.author = FakeAuthor(username)
        self.text = text


class FakeUser:
    def __init__(self, items: list[FakeVideo]) -> None:
        self._items = items

    def feed(self) -> Any:
        async def _gen() -> Any:
            for v in self._items:
                yield v
        return _gen()


class FakeApi:
    def __init__(self, videos: list[FakeVideo]) -> None:
        self.user = FakeUser(videos)
        self._comments_should_fail: bool = False
        self._comments: list[Any] = []

    def video(self, id: str) -> Any:
        outer = self

        class _Vid:
            def comments(self_inner) -> Any:
                async def _gen() -> Any:
                    if outer._comments_should_fail:
                        raise RuntimeError("rate-limited")
                    for c in outer._comments:
                        yield c
                return _gen()

        return _Vid()

    # session.py uses these; required for validate compile path
    async def create_sessions(
        self, *, ms_tokens: list[str], num_sessions: int = 1
    ) -> None: ...

    async def close_sessions(self) -> None: ...


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build(
    api: FakeApi,
    tmp_path: Path,
    *,
    count: int = 20,
) -> dict[str, Any]:
    session = TikTokSession(
        client=api,
        session_path=tmp_path / "tiktok.json",
        runner=sync_runner,
    )
    return build_handlers(session, runner=sync_runner, count=count)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_validate_returns_login_required_when_no_session_file(tmp_path: Path) -> None:
    h = _build(FakeApi([]), tmp_path)
    out = h["validate"](None)
    assert out == {"status": "login_required", "message": None}


def test_set_token_writes_file_at_mode_0600_and_returns_ready(tmp_path: Path) -> None:
    h = _build(FakeApi([]), tmp_path)
    out = h["set_token"]({"ms_token": "x"})
    assert out == {"status": "ready", "message": None}
    token_file = tmp_path / "tiktok.json"
    assert token_file.exists()
    mode = stat.S_IMODE(token_file.stat().st_mode)
    assert mode == 0o600


def test_feed_list_serializes_videos_with_canonical_tiktok_url(tmp_path: Path) -> None:
    videos = [
        FakeVideo("v1", "alice", "first video"),
        FakeVideo("v2", "bob", "second video"),
        FakeVideo("v3", "carol", "third video"),
    ]
    h = _build(FakeApi(videos), tmp_path)
    out = h["feed/list"](None)
    assert out == {
        "items": [
            {
                "id": "v1",
                "author": "alice",
                "caption": "first video",
                "url": "https://www.tiktok.com/@alice/video/v1",
            },
            {
                "id": "v2",
                "author": "bob",
                "caption": "second video",
                "url": "https://www.tiktok.com/@bob/video/v2",
            },
            {
                "id": "v3",
                "author": "carol",
                "caption": "third video",
                "url": "https://www.tiktok.com/@carol/video/v3",
            },
        ]
    }


def test_feed_list_empty_iterator_returns_empty_items(tmp_path: Path) -> None:
    h = _build(FakeApi([]), tmp_path)
    out = h["feed/list"](None)
    assert out == {"items": []}


def test_feed_list_truncates_to_count(tmp_path: Path) -> None:
    videos = [FakeVideo(f"v{i}", f"user{i}", f"desc{i}") for i in range(5)]
    h = _build(FakeApi(videos), tmp_path, count=2)
    out = h["feed/list"](None)
    assert len(out["items"]) == 2
    assert out["items"][0]["id"] == "v0"
    assert out["items"][1]["id"] == "v1"


def test_feed_comments_serializes_comments(tmp_path: Path) -> None:
    api = FakeApi([])
    api._comments = [
        FakeComment("alice", "great video!"),
        FakeComment("bob", "love it"),
    ]
    h = _build(api, tmp_path)
    out = h["feed/comments"]({"video_id": "abc"})
    assert out == {
        "available": True,
        "items": [
            {"from": "alice", "text": "great video!"},
            {"from": "bob", "text": "love it"},
        ],
    }


def test_feed_comments_degrades_on_exception(tmp_path: Path) -> None:
    api = FakeApi([])
    api._comments_should_fail = True
    h = _build(api, tmp_path)
    out = h["feed/comments"]({"video_id": "abc"})
    assert out["available"] is False
    assert out["items"] == []
    assert "rate-limited" in out["message"]


def test_feed_comments_returns_available_true_on_success(tmp_path: Path) -> None:
    api = FakeApi([])
    api._comments = [FakeComment("zara", "nice")]
    h = _build(api, tmp_path)
    out = h["feed/comments"]({"video_id": "xyz"})
    assert out["available"] is True
    assert out["items"] == [{"from": "zara", "text": "nice"}]
