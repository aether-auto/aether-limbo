"""Tests for the twitter-home sidecar handlers (no twikit required)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from limbo_sidecars.twitter.home import build_handlers
from limbo_sidecars.twitter.session import TwitterSession


# ---------------------------------------------------------------------------
# sync_runner duplicated from test_twitter_session.py (intentional — these
# tests are stdlib-only and don't import that test module).
# ---------------------------------------------------------------------------
def sync_runner(coro: Any) -> Any:
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value


class FakeClient:
    """Hand-rolled fake — only the methods the handlers touch."""

    def __init__(self) -> None:
        self.like_calls: list[str] = []
        self.reply_calls: list[tuple[str, str]] = []
        self.dm_threads_should_fail: bool = False
        self.dm_messages_should_fail: bool = False

    # session.py uses these — required for the validate path to compile.
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
            SimpleNamespace(
                id="222",
                text="second tweet",
                user=SimpleNamespace(screen_name="bob"),
            ),
        ]

    async def favorite_tweet(self, tweet_id: str) -> Any:
        self.like_calls.append(tweet_id)
        return SimpleNamespace(id=tweet_id, favorited=True)

    async def create_tweet(self, *, text: str, reply_to: str) -> Any:
        self.reply_calls.append((reply_to, text))
        return SimpleNamespace(id="999")

    async def get_dm_threads(self) -> list[Any]:
        if self.dm_threads_should_fail:
            raise RuntimeError("DMs require X Premium")
        return [
            SimpleNamespace(id="t1", name="alice", last_message_text="hi"),
            SimpleNamespace(id="t2", name="bob", last_message_text="bye"),
        ]

    async def get_dm_messages(self, thread_id: str) -> list[Any]:
        if self.dm_messages_should_fail:
            raise RuntimeError("DMs require X Premium")
        return [
            SimpleNamespace(sender_id="42", text="hello", timestamp="ts1"),
            SimpleNamespace(sender_id="43", text="world", timestamp="ts2"),
        ]


def _build(client: FakeClient, tmp_path: Path) -> dict[str, Any]:
    s = TwitterSession(
        client=client, session_path=tmp_path / "twitter.json", runner=sync_runner
    )
    return build_handlers(s, runner=sync_runner)


def test_timeline_list_serializes_two_tweets(tmp_path: Path) -> None:
    h = _build(FakeClient(), tmp_path)
    out = h["timeline/list"](None)
    assert out == {
        "items": [
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
    }


def test_timeline_like_calls_favorite_tweet(tmp_path: Path) -> None:
    client = FakeClient()
    h = _build(client, tmp_path)
    out = h["timeline/like"]({"tweet_id": "111"})
    assert out == {"ok": True, "message": None}
    assert client.like_calls == ["111"]


def test_timeline_reply_calls_create_tweet_with_reply_to(tmp_path: Path) -> None:
    client = FakeClient()
    h = _build(client, tmp_path)
    out = h["timeline/reply"]({"tweet_id": "111", "text": "yo back"})
    assert out == {"ok": True, "message": None}
    assert client.reply_calls == [("111", "yo back")]


def test_dms_threads_returns_available_true_with_items(tmp_path: Path) -> None:
    h = _build(FakeClient(), tmp_path)
    out = h["dms/threads"](None)
    assert out == {
        "available": True,
        "items": [
            {"thread_id": "t1", "title": "alice", "last_message": "hi"},
            {"thread_id": "t2", "title": "bob", "last_message": "bye"},
        ],
    }


def test_dms_threads_degrades_when_paid_tier_rejects(tmp_path: Path) -> None:
    client = FakeClient()
    client.dm_threads_should_fail = True
    h = _build(client, tmp_path)
    out = h["dms/threads"](None)
    assert out["available"] is False
    assert out["items"] == []
    assert "Premium" in out["message"]


def test_dms_messages_returns_items_when_available(tmp_path: Path) -> None:
    h = _build(FakeClient(), tmp_path)
    out = h["dms/messages"]({"thread_id": "t1"})
    assert out == {
        "available": True,
        "items": [
            {"from": "42", "text": "hello", "ts": "ts1"},
            {"from": "43", "text": "world", "ts": "ts2"},
        ],
    }


def test_dms_messages_degrades_when_paid_tier_rejects(tmp_path: Path) -> None:
    client = FakeClient()
    client.dm_messages_should_fail = True
    h = _build(client, tmp_path)
    out = h["dms/messages"]({"thread_id": "t1"})
    assert out["available"] is False
    assert out["items"] == []


def test_login_handler_remembers_credentials_for_login_2fa(tmp_path: Path) -> None:
    """If twikit raises a 2FA-shaped exception, the handler should remember
    the creds so login_2fa can re-submit them with a code attached."""

    class TwoFAFailingClient(FakeClient):
        first: bool = True

        async def login(self, **kw: Any) -> bool:
            if self.first:
                self.first = False
                raise RuntimeError("verification challenge required")
            # second login (with code) succeeds
            return True

    client = TwoFAFailingClient()
    h = _build(client, tmp_path)
    out1 = h["login"]({"username": "alice", "password": "pw"})
    assert out1["status"] == "2fa_required"
    out2 = h["login_2fa"]({"code": "123456"})
    assert out2["status"] == "ready"
