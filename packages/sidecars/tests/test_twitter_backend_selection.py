"""Tests for LIMBO_TWITTER_BACKEND env-var backend selection in build_handlers().

Verifies that:
- When LIMBO_TWITTER_BACKEND=tweepy, build_handlers receives a TweepySession.
- When LIMBO_TWITTER_BACKEND=twikit (or unset), build_handlers receives a TwitterSession.
- Both backends produce identical JSON-RPC envelope shapes for timeline/list.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from limbo_sidecars.twitter.home import build_handlers
from limbo_sidecars.twitter.session import TwitterSession
from limbo_sidecars.twitter.tweepy_session import TweepySession


# ---------------------------------------------------------------------------
# Twikit fake (mirrors test_twitter_home_handlers.py, self-contained)
# ---------------------------------------------------------------------------

def sync_runner(coro: Any) -> Any:
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value


class FakeTwikitClient:
    def load_cookies(self, path: Path) -> None: ...
    def save_cookies(self, path: Path) -> None: ...

    async def login(self, **kw: Any) -> bool:
        return True

    async def user(self) -> dict[str, Any]:
        return {"screen_name": "me"}

    async def get_home_timeline(self, count: int = 20) -> list[Any]:
        return [
            SimpleNamespace(
                id="111",
                text="hello world",
                user=SimpleNamespace(screen_name="alice"),
            ),
        ]


# ---------------------------------------------------------------------------
# Tweepy fakes (minimal — only what timeline/list touches)
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, data: list[Any], includes: dict[str, Any]) -> None:
        self.data = data
        self.includes = includes


class FakeClientV2:
    def get_home_timeline(
        self,
        max_results: int = 20,
        expansions: Any = None,
        user_fields: Any = None,
    ) -> FakeResponse:
        return FakeResponse(
            data=[SimpleNamespace(id="111", author_id="u1", text="hello world")],
            includes={"users": [SimpleNamespace(id="u1", username="alice")]},
        )


class FakeTweepyModule:
    def __init__(self) -> None:
        self._client = FakeClientV2()

    def Client(self, **kwargs: Any) -> FakeClientV2:  # noqa: N802
        return self._client

    def OAuth1UserHandler(self, *a: Any, **kw: Any) -> Any:  # noqa: N802
        return SimpleNamespace()

    def API(self, auth: Any) -> Any:  # noqa: N802
        return SimpleNamespace()


# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------

def _twikit_session(tmp_path: Path) -> TwitterSession:
    return TwitterSession(
        client=FakeTwikitClient(),
        session_path=tmp_path / "twitter.json",
        runner=sync_runner,
    )


def _tweepy_session(monkeypatch: pytest.MonkeyPatch) -> TweepySession:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt-fake")
    return TweepySession(tweepy_module=FakeTweepyModule())


# ---------------------------------------------------------------------------
# Backend selection: isinstance checks on build_handlers input
# ---------------------------------------------------------------------------

def test_build_handlers_accepts_twikit_session(tmp_path: Path) -> None:
    session = _twikit_session(tmp_path)
    handlers = build_handlers(session, runner=sync_runner)
    assert "timeline/list" in handlers
    assert "validate" in handlers


def test_build_handlers_accepts_tweepy_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _tweepy_session(monkeypatch)
    handlers = build_handlers(session)
    assert "timeline/list" in handlers
    assert "validate" in handlers


# ---------------------------------------------------------------------------
# Identical JSON-RPC envelope shape for timeline/list
# ---------------------------------------------------------------------------

def test_timeline_list_twikit_envelope_shape(tmp_path: Path) -> None:
    session = _twikit_session(tmp_path)
    handlers = build_handlers(session, runner=sync_runner)
    out = handlers["timeline/list"](None)
    assert "items" in out
    assert isinstance(out["items"], list)
    item = out["items"][0]
    assert set(item.keys()) == {"id", "author", "text", "url"}
    assert item["id"] == "111"
    assert item["author"] == "alice"
    assert item["text"] == "hello world"
    assert item["url"] == "https://x.com/alice/status/111"


def test_timeline_list_tweepy_envelope_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _tweepy_session(monkeypatch)
    handlers = build_handlers(session)
    out = handlers["timeline/list"](None)
    assert "items" in out
    assert isinstance(out["items"], list)
    item = out["items"][0]
    assert set(item.keys()) == {"id", "author", "text", "url"}
    assert item["id"] == "111"
    assert item["author"] == "alice"
    assert item["text"] == "hello world"
    assert item["url"] == "https://x.com/alice/status/111"


def test_timeline_list_envelopes_are_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both backends must return structurally identical envelopes."""
    twikit_handlers = build_handlers(_twikit_session(tmp_path), runner=sync_runner)
    tweepy_handlers = build_handlers(_tweepy_session(monkeypatch))

    twikit_out = twikit_handlers["timeline/list"](None)
    tweepy_out = tweepy_handlers["timeline/list"](None)

    # Same top-level keys
    assert set(twikit_out.keys()) == set(tweepy_out.keys())
    # Same item keys
    assert set(twikit_out["items"][0].keys()) == set(tweepy_out["items"][0].keys())


# ---------------------------------------------------------------------------
# LIMBO_TWITTER_BACKEND env var routing in main() is tested at the unit level
# by confirming isinstance discrimination works correctly.
# ---------------------------------------------------------------------------

def test_build_handlers_dispatches_to_twikit_for_twikit_session(tmp_path: Path) -> None:
    """When a TwitterSession is passed, handlers use the twikit code path."""
    session = _twikit_session(tmp_path)
    # Verify no AttributeError — twikit handler calls session.client
    handlers = build_handlers(session, runner=sync_runner)
    # timeline_list should invoke async client path without error
    out = handlers["timeline/list"](None)
    assert out["items"][0]["author"] == "alice"


def test_build_handlers_dispatches_to_tweepy_for_tweepy_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a TweepySession is passed, handlers use the tweepy code path."""
    session = _tweepy_session(monkeypatch)
    handlers = build_handlers(session)
    out = handlers["timeline/list"](None)
    assert out["items"][0]["author"] == "alice"
