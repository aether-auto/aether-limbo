"""Tests for the tiktok-foryou sidecar handlers (no TikTokApi required)."""
from __future__ import annotations

import os
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
    def __init__(self, items: list[FakeVideo], api_ref: "FakeApi | None" = None) -> None:
        self._items = items
        self._api_ref = api_ref

    def feed(self) -> Any:
        outer_api = self._api_ref
        items = self._items

        async def _gen() -> Any:
            if outer_api is not None:
                outer_api._feed_call_count += 1
                if outer_api._feed_call_count <= outer_api._feed_fail_times:
                    raise RuntimeError("auth error")
            for v in items:
                yield v
        return _gen()


class FakeApi:
    def __init__(self, videos: list[FakeVideo]) -> None:
        self.user = FakeUser(videos, api_ref=self)
        self._comments_should_fail: bool = False
        self._comments: list[Any] = []
        # Feed failure support: if > 0 the feed() call raises on each of the
        # first N invocations; subsequent calls succeed normally.
        self._feed_fail_times: int = 0
        self._feed_call_count: int = 0
        # Tracks how many times create_sessions was called (for assertions).
        self.create_sessions_call_count: int = 0
        self.create_sessions_tokens: list[list[str]] = []

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
    ) -> None:
        self.create_sessions_call_count += 1
        self.create_sessions_tokens.append(ms_tokens)

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


# ---------------------------------------------------------------------------
# Refresh-on-failure tests (§4.9 carry-over)
# ---------------------------------------------------------------------------

def test_feed_list_refresh_disabled_falls_through_to_form_on_failure(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Refresh disabled → first failure lands on the failed/form path immediately."""
    monkeypatch.delenv("LIMBO_TIKTOK_REFRESH_ON_FAILURE", raising=False)
    api = FakeApi([FakeVideo("v1", "alice", "desc")])
    api._feed_fail_times = 1  # first call raises
    h = _build(api, tmp_path)
    out = h["feed/list"](None)
    # Falls through to the LoginResult "failed" shape
    assert out["status"] == "failed"
    # create_sessions was NOT called for a refresh attempt
    assert api.create_sessions_call_count == 0


def test_feed_list_refresh_enabled_retry_succeeds(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Refresh enabled, first call fails, retry succeeds → returns items; create_sessions called once, feed called twice."""
    monkeypatch.setenv("LIMBO_TIKTOK_REFRESH_ON_FAILURE", "1")
    monkeypatch.setenv("LIMBO_TIKTOK_MS_TOKEN", "fresh-token-abc")
    videos = [FakeVideo("v1", "alice", "desc")]
    api = FakeApi(videos)
    api._feed_fail_times = 1  # only the first feed() call fails
    h = _build(api, tmp_path)
    out = h["feed/list"](None)
    assert "items" in out
    assert out["items"][0]["id"] == "v1"
    # create_sessions called exactly once with the fresh token
    assert api.create_sessions_call_count == 1
    assert api.create_sessions_tokens[0] == ["fresh-token-abc"]
    # feed was called twice: first failure + successful retry
    assert api._feed_call_count == 2


def test_feed_list_refresh_enabled_retry_also_fails_falls_through_to_form(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Refresh enabled, both calls fail → falls through to form path."""
    monkeypatch.setenv("LIMBO_TIKTOK_REFRESH_ON_FAILURE", "1")
    monkeypatch.setenv("LIMBO_TIKTOK_MS_TOKEN", "stale-token")
    api = FakeApi([FakeVideo("v1", "alice", "desc")])
    api._feed_fail_times = 2  # both calls fail
    h = _build(api, tmp_path)
    out = h["feed/list"](None)
    assert out["status"] == "failed"
    # create_sessions was still called once (the refresh attempt was made)
    assert api.create_sessions_call_count == 1
    # feed was called twice: original + retry
    assert api._feed_call_count == 2


def test_feed_list_refresh_enabled_second_failure_no_second_retry(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Refresh enabled: once the guard fires, a second failure in the same session does NOT trigger another retry."""
    monkeypatch.setenv("LIMBO_TIKTOK_REFRESH_ON_FAILURE", "1")
    monkeypatch.setenv("LIMBO_TIKTOK_MS_TOKEN", "token-x")
    api = FakeApi([FakeVideo("v1", "alice", "desc")])
    api._feed_fail_times = 999  # every call will fail
    h = _build(api, tmp_path)

    # First call: triggers one retry (guard fires)
    out1 = h["feed/list"](None)
    assert out1["status"] == "failed"
    assert api.create_sessions_call_count == 1  # exactly one refresh

    # Second call on the same handler-set: guard already consumed, no new retry
    out2 = h["feed/list"](None)
    assert out2["status"] == "failed"
    # create_sessions still only called once — no second retry
    assert api.create_sessions_call_count == 1
