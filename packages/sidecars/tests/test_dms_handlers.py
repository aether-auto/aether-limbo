"""Tests for Instagram DMs sidecar handlers (no instagrapi required)."""
from __future__ import annotations
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from limbo_sidecars.instagram.dms import build_handlers
from limbo_sidecars.instagram.session import IGSession


class TwoFactor(Exception): pass


class FakeClient:
    def __init__(self) -> None:
        self.send_calls: list[tuple[str, list[str]]] = []

    def load_settings(self, path: Path) -> None: ...
    def dump_settings(self, path: Path) -> None: ...
    def login(self, *a: Any, **k: Any) -> bool: return True
    def get_timeline_feed(self) -> Any: return {}

    def direct_threads(self, amount: int = 20) -> list[Any]:
        return [
            SimpleNamespace(
                id="t1",
                users=[SimpleNamespace(username="alice")],
                messages=[SimpleNamespace(text="hi")],
            ),
            SimpleNamespace(
                id="t2",
                users=[SimpleNamespace(username="bob")],
                messages=[SimpleNamespace(text="bye")],
            ),
        ]

    def direct_messages(self, thread_id: str, amount: int = 20) -> list[Any]:
        return [
            SimpleNamespace(user_id="42", text="hello", timestamp="ts1"),
            SimpleNamespace(user_id="43", text="world", timestamp="ts2"),
        ]

    def direct_send(self, text: str, thread_ids: list[str]) -> Any:
        self.send_calls.append((text, thread_ids))
        return SimpleNamespace(id="m99")


def test_threads_handler_serializes(tmp_path: Path) -> None:
    s = IGSession(client=FakeClient(), session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(s)
    out = h["dms/threads"](None)
    assert out == {"items": [
        {"thread_id": "t1", "title": "alice", "last_message": "hi"},
        {"thread_id": "t2", "title": "bob", "last_message": "bye"},
    ]}


def test_messages_handler_serializes(tmp_path: Path) -> None:
    s = IGSession(client=FakeClient(), session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(s)
    out = h["dms/messages"]({"thread_id": "t1"})
    assert out == {"items": [
        {"from": "42", "text": "hello", "ts": "ts1"},
        {"from": "43", "text": "world", "ts": "ts2"},
    ]}


def test_send_handler_calls_direct_send(tmp_path: Path) -> None:
    client = FakeClient()
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(s)
    out = h["dms/send"]({"thread_id": "t1", "text": "yo"})
    assert out == {"ok": True, "message": None}
    assert client.send_calls == [("yo", ["t1"])]
