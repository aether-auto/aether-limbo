"""Integration tests for the Instagram bundle sidecar.

Tests that validate/login/login_2fa, media/list, feed/list, and the dms
handlers all share a single IGSession, and that all method names match
what the host adapters call.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from limbo_sidecars.instagram.bundle import build_handlers
from limbo_sidecars.instagram.session import IGSession


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class TwoFactor(Exception):
    pass


class FakeClient:
    """Minimal fake covering every method the bundle calls."""

    def __init__(self) -> None:
        self.username_seen: str | None = None
        self.send_calls: list[tuple[str, list[str]]] = []

    def load_settings(self, path: Path) -> None: ...

    def dump_settings(self, path: Path) -> None:
        # Write a minimal session file so subsequent validate() calls can find it.
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"sessionid": "fake"}')

    def login(self, username: str, password: str, verification_code: str | None = None) -> bool:
        self.username_seen = username
        return True

    def get_timeline_feed(self) -> Any:
        return {}

    def user_id_from_username(self, name: str) -> str:
        return name + "_pk"

    def user_clips(self, user_id: str, amount: int = 0) -> list[Any]:
        return [
            SimpleNamespace(pk="111", code="r1", caption_text="reel one"),
            SimpleNamespace(pk="222", code="r2", caption_text="reel two"),
        ]

    def user_feed(self, user_id: str, amount: int = 0) -> list[Any]:
        return [
            SimpleNamespace(
                pk="1",
                code="f1",
                caption_text="feed post",
                user=SimpleNamespace(username="alice"),
            ),
        ]

    def direct_threads(self, amount: int = 20) -> list[Any]:
        return [
            SimpleNamespace(
                id="t1",
                users=[SimpleNamespace(username="alice")],
                messages=[SimpleNamespace(text="hi")],
            ),
        ]

    def direct_messages(self, thread_id: str, amount: int = 20) -> list[Any]:
        return [SimpleNamespace(user_id="42", text="hello", timestamp="ts1")]

    def direct_send(self, text: str, thread_ids: list[str]) -> Any:
        self.send_calls.append((text, thread_ids))
        return SimpleNamespace(id="m99")


# ---------------------------------------------------------------------------
# Method-name coverage — every slug the host adapters call must be present
# ---------------------------------------------------------------------------

def test_bundle_exports_all_expected_method_names(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
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


# ---------------------------------------------------------------------------
# Shared session: login once, all namespaces see the authenticated state
# ---------------------------------------------------------------------------

def test_login_once_then_all_namespaces_use_same_session(tmp_path: Path) -> None:
    """Login via the shared handler, then verify each namespace's data handler
    executes against the same (now-authenticated) session without re-logging in.
    """
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "ig.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")

    # Not logged in yet.
    validate_result = h["validate"](None)
    assert validate_result["status"] == "login_required"

    # Log in once via the shared handler.
    login_result = h["login"]({"username": "testuser", "password": "testpass"})
    assert login_result["status"] == "ready"
    assert client.username_seen == "testuser"

    # Validate now reports ready.
    assert h["validate"](None)["status"] == "ready"

    # media/list works on the same session (no second login needed).
    reels_result = h["media/list"](None)
    assert len(reels_result["items"]) == 2
    assert reels_result["items"][0]["code"] == "r1"

    # feed/list works on the same session.
    feed_result = h["feed/list"](None)
    assert len(feed_result["items"]) == 1
    assert feed_result["items"][0]["author"] == "alice"

    # dms/threads works on the same session.
    threads_result = h["dms/threads"](None)
    assert len(threads_result["items"]) == 1
    assert threads_result["items"][0]["title"] == "alice"


# ---------------------------------------------------------------------------
# Individual handler correctness (via bundle entrypoint)
# ---------------------------------------------------------------------------

def test_media_list_shape(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    sess = IGSession(client=FakeClient(), session_path=session_path, two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")
    out = h["media/list"](None)
    assert out == {"items": [
        {"pk": "111", "code": "r1", "caption": "reel one",
         "url": "https://www.instagram.com/reel/r1/"},
        {"pk": "222", "code": "r2", "caption": "reel two",
         "url": "https://www.instagram.com/reel/r2/"},
    ]}


def test_feed_list_shape(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    sess = IGSession(client=FakeClient(), session_path=session_path, two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")
    out = h["feed/list"](None)
    assert out == {"items": [
        {"pk": "1", "code": "f1", "author": "alice", "caption": "feed post",
         "url": "https://www.instagram.com/p/f1/"},
    ]}


def test_dms_threads_shape(tmp_path: Path) -> None:
    sess = IGSession(
        client=FakeClient(), session_path=tmp_path / "x.json", two_factor_exc=TwoFactor
    )
    h = build_handlers(sess, target_username="")
    out = h["dms/threads"](None)
    assert out == {"items": [{"thread_id": "t1", "title": "alice", "last_message": "hi"}]}


def test_dms_messages_shape(tmp_path: Path) -> None:
    sess = IGSession(
        client=FakeClient(), session_path=tmp_path / "x.json", two_factor_exc=TwoFactor
    )
    h = build_handlers(sess, target_username="")
    out = h["dms/messages"]({"thread_id": "t1"})
    assert out == {"items": [{"from": "42", "text": "hello", "ts": "ts1"}]}


def test_dms_send_ok(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="")
    out = h["dms/send"]({"thread_id": "t1", "text": "yo"})
    assert out == {"ok": True, "message": None}
    assert client.send_calls == [("yo", ["t1"])]


def test_login_2fa_uses_remembered_credentials(tmp_path: Path) -> None:
    """login stores credentials; login_2fa re-uses them with the 2FA code."""
    login_attempts: list[dict[str, Any]] = []

    class Fa2Client(FakeClient):
        call_count = 0

        def login(
            self,
            username: str,
            password: str,
            verification_code: str | None = None,
        ) -> bool:
            login_attempts.append(
                {"username": username, "password": password, "code": verification_code}
            )
            self.username_seen = username
            return True

    sess = IGSession(
        client=Fa2Client(), session_path=tmp_path / "x.json", two_factor_exc=TwoFactor
    )
    h = build_handlers(sess, target_username="")

    h["login"]({"username": "u1", "password": "p1"})
    h["login_2fa"]({"code": "123456"})

    assert len(login_attempts) == 2
    # Second call must reuse the credentials stored by the first call.
    assert login_attempts[1]["username"] == "u1"
    assert login_attempts[1]["password"] == "p1"
    assert login_attempts[1]["code"] == "123456"
