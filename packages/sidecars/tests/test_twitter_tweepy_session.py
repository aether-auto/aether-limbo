"""Tests for TweepySession with a hand-rolled fake tweepy module."""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from limbo_sidecars.twitter.tweepy_session import TweepySession


# ---------------------------------------------------------------------------
# Fake tweepy module
# ---------------------------------------------------------------------------

class FakeResponse:
    """Mimics tweepy.Response for get_home_timeline."""

    def __init__(
        self,
        data: Optional[list[Any]] = None,
        includes: Optional[dict[str, Any]] = None,
    ) -> None:
        self.data = data or []
        self.includes = includes or {}


class FakeClientV2:
    """Fake tweepy.Client (v2)."""

    def __init__(self) -> None:
        self.like_calls: list[tuple[Any, str]] = []
        self.create_tweet_calls: list[tuple[str, str]] = []
        self.raise_on_like: Optional[Exception] = None
        self.raise_on_create_tweet: Optional[Exception] = None
        self._me_id = "me-id-1"

    def get_me(self) -> Any:
        return SimpleNamespace(data=SimpleNamespace(id=self._me_id))

    def get_home_timeline(
        self,
        max_results: int = 20,
        expansions: Any = None,
        user_fields: Any = None,
    ) -> FakeResponse:
        users = [
            SimpleNamespace(id="u1", username="alice"),
            SimpleNamespace(id="u2", username="bob"),
        ]
        tweets = [
            SimpleNamespace(id="111", author_id="u1", text="hello world"),
            SimpleNamespace(id="222", author_id="u2", text="second tweet"),
        ][:max_results]
        return FakeResponse(data=tweets, includes={"users": users})

    def like(self, *, tweet_id: str, user_auth: bool = False, **kwargs: Any) -> Any:
        if self.raise_on_like is not None:
            raise self.raise_on_like
        self.like_calls.append(tweet_id)
        return SimpleNamespace(data=SimpleNamespace(liked=True))

    def create_tweet(self, *, text: str, in_reply_to_tweet_id: str) -> Any:
        if self.raise_on_create_tweet is not None:
            raise self.raise_on_create_tweet
        self.create_tweet_calls.append((in_reply_to_tweet_id, text))
        return SimpleNamespace(data=SimpleNamespace(id="999"))


class FakeDmMessage:
    def __init__(
        self, sender_id: str, sender_screen_name: str, text: str, created_at: str
    ) -> None:
        self.sender_id = sender_id
        self.sender_screen_name = sender_screen_name
        self.text = text
        self.created_at = created_at


class FakeApiV1:
    """Fake tweepy.API (v1.1)."""

    def __init__(self) -> None:
        self.raise_on_dm: Optional[Exception] = None
        self._messages: list[FakeDmMessage] = [
            FakeDmMessage("u1", "alice", "hey there", "2024-01-01"),
            FakeDmMessage("u2", "bob", "yo", "2024-01-02"),
        ]

    def get_direct_messages(self) -> list[FakeDmMessage]:
        if self.raise_on_dm is not None:
            raise self.raise_on_dm
        return self._messages


class FakeTweepyModule:
    """Minimal fake of the tweepy module."""

    def __init__(
        self,
        client_v2: Optional[FakeClientV2] = None,
        api_v1: Optional[FakeApiV1] = None,
    ) -> None:
        self._client_v2 = client_v2 or FakeClientV2()
        self._api_v1 = api_v1 or FakeApiV1()

    # tweepy.Client(bearer_token=...) — ignore args, return fake
    def Client(self, **kwargs: Any) -> FakeClientV2:  # noqa: N802
        return self._client_v2

    # tweepy.OAuth1UserHandler(...)
    def OAuth1UserHandler(self, *args: Any, **kwargs: Any) -> Any:  # noqa: N802
        return SimpleNamespace()

    # tweepy.API(auth)
    def API(self, auth: Any, **kwargs: Any) -> FakeApiV1:  # noqa: N802
        return self._api_v1


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_tweepy() -> FakeTweepyModule:
    return FakeTweepyModule()


@pytest.fixture()
def session_ok(monkeypatch: pytest.MonkeyPatch, fake_tweepy: FakeTweepyModule) -> TweepySession:
    """Session with all env vars set."""
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt-fake")
    monkeypatch.setenv("TWITTER_API_KEY", "key")
    monkeypatch.setenv("TWITTER_API_SECRET", "secret")
    monkeypatch.setenv("TWITTER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("TWITTER_ACCESS_SECRET", "token-secret")
    return TweepySession(tweepy_module=fake_tweepy)


@pytest.fixture()
def session_no_bearer(monkeypatch: pytest.MonkeyPatch, fake_tweepy: FakeTweepyModule) -> TweepySession:
    """Session with bearer token missing."""
    monkeypatch.delenv("TWITTER_BEARER_TOKEN", raising=False)
    monkeypatch.setenv("TWITTER_API_KEY", "key")
    monkeypatch.setenv("TWITTER_API_SECRET", "secret")
    monkeypatch.setenv("TWITTER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("TWITTER_ACCESS_SECRET", "token-secret")
    return TweepySession(tweepy_module=fake_tweepy)


# ---------------------------------------------------------------------------
# validate()
# ---------------------------------------------------------------------------

def test_validate_returns_ok_when_bearer_present(session_ok: TweepySession) -> None:
    assert session_ok.validate() == {"status": "ok"}


def test_validate_returns_needs_auth_when_bearer_missing(
    session_no_bearer: TweepySession,
) -> None:
    assert session_no_bearer.validate() == {"status": "needs_auth"}


# ---------------------------------------------------------------------------
# login() / login_2fa()
# ---------------------------------------------------------------------------

def test_login_returns_ok_when_bearer_present(session_ok: TweepySession) -> None:
    result = session_ok.login(username="ignored", password="ignored")
    assert result["status"] == "ok"


def test_login_returns_missing_keys_when_bearer_absent(
    session_no_bearer: TweepySession,
) -> None:
    result = session_no_bearer.login()
    assert result["status"] == "missing_keys"
    assert "TWITTER_BEARER_TOKEN" in result["message"]


def test_login_2fa_always_returns_ok(session_ok: TweepySession) -> None:
    assert session_ok.login_2fa(code="123456") == {"status": "ok"}


# ---------------------------------------------------------------------------
# home_timeline()
# ---------------------------------------------------------------------------

def test_home_timeline_returns_serialised_tweets(session_ok: TweepySession) -> None:
    items = session_ok.home_timeline(limit=20)
    assert items == [
        {
            "id": "111",
            "author": "alice",
            "text": "hello world",
            "url": "https://x.com/alice/status/111",
        },
        {
            "id": "222",
            "author": "bob",
            "text": "second tweet",
            "url": "https://x.com/bob/status/222",
        },
    ]


def test_home_timeline_respects_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt")
    client = FakeClientV2()
    tw = FakeTweepyModule(client_v2=client)
    s = TweepySession(tweepy_module=tw)
    items = s.home_timeline(limit=1)
    assert len(items) == 1


# ---------------------------------------------------------------------------
# like()
# ---------------------------------------------------------------------------

def test_like_calls_client_like_and_returns_ok(session_ok: TweepySession, fake_tweepy: FakeTweepyModule) -> None:
    result = session_ok.like("111")
    assert result == {"ok": True}
    assert fake_tweepy._client_v2.like_calls[0] == "111"


def test_like_returns_error_dict_on_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt")
    client = FakeClientV2()
    client.raise_on_like = RuntimeError("rate limited")
    tw = FakeTweepyModule(client_v2=client)
    s = TweepySession(tweepy_module=tw)
    result = s.like("111")
    assert result["ok"] is False
    assert "rate limited" in result["message"]


# ---------------------------------------------------------------------------
# reply()
# ---------------------------------------------------------------------------

def test_reply_calls_create_tweet_and_returns_ok(
    session_ok: TweepySession, fake_tweepy: FakeTweepyModule
) -> None:
    result = session_ok.reply(tweet_id="111", text="nice")
    assert result == {"ok": True}
    assert fake_tweepy._client_v2.create_tweet_calls[0] == ("111", "nice")


def test_reply_returns_error_dict_on_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt")
    client = FakeClientV2()
    client.raise_on_create_tweet = RuntimeError("forbidden")
    tw = FakeTweepyModule(client_v2=client)
    s = TweepySession(tweepy_module=tw)
    result = s.reply(tweet_id="111", text="yo")
    assert result["ok"] is False
    assert "forbidden" in result["message"]


# ---------------------------------------------------------------------------
# dm_threads()
# ---------------------------------------------------------------------------

def test_dm_threads_returns_available_true_on_success(session_ok: TweepySession) -> None:
    result = session_ok.dm_threads()
    assert result["available"] is True
    assert len(result["items"]) == 2
    thread_ids = {item["thread_id"] for item in result["items"]}
    assert "u1" in thread_ids
    assert "u2" in thread_ids


def test_dm_threads_degrades_on_api_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt")
    monkeypatch.setenv("TWITTER_API_KEY", "key")
    monkeypatch.setenv("TWITTER_API_SECRET", "secret")
    monkeypatch.setenv("TWITTER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("TWITTER_ACCESS_SECRET", "token-secret")
    api = FakeApiV1()
    api.raise_on_dm = RuntimeError("401 Unauthorized: DMs require paid tier")
    tw = FakeTweepyModule(api_v1=api)
    s = TweepySession(tweepy_module=tw)
    result = s.dm_threads()
    assert result["available"] is False
    assert result["items"] == []
    assert "401" in result["message"] or "Unauthorized" in result["message"]


# ---------------------------------------------------------------------------
# dm_messages()
# ---------------------------------------------------------------------------

def test_dm_messages_returns_messages_for_thread(session_ok: TweepySession) -> None:
    result = session_ok.dm_messages("u1")
    assert result["available"] is True
    assert len(result["items"]) == 1
    assert result["items"][0]["from"] == "u1"
    assert result["items"][0]["text"] == "hey there"


def test_dm_messages_degrades_on_api_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TWITTER_BEARER_TOKEN", "bt")
    monkeypatch.setenv("TWITTER_API_KEY", "key")
    monkeypatch.setenv("TWITTER_API_SECRET", "secret")
    monkeypatch.setenv("TWITTER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("TWITTER_ACCESS_SECRET", "token-secret")
    api = FakeApiV1()
    api.raise_on_dm = RuntimeError("403 Forbidden")
    tw = FakeTweepyModule(api_v1=api)
    s = TweepySession(tweepy_module=tw)
    result = s.dm_messages("u1")
    assert result["available"] is False
    assert result["items"] == []
