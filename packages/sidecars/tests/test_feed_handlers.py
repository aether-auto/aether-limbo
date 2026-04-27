"""Tests for Instagram feed sidecar handlers (no instagrapi required)."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from limbo_sidecars.instagram.feed import build_handlers
from limbo_sidecars.instagram.session import IGSession


class TwoFactor(Exception):
    pass


class FakeClient:
    def __init__(self) -> None:
        self.username_seen: str | None = None

    def load_settings(self, path: Path) -> None: ...
    def dump_settings(self, path: Path) -> None: ...

    def login(self, username: str, password: str, verification_code: str | None = None) -> bool:
        self.username_seen = username
        return True

    def get_timeline_feed(self) -> Any:
        return {}

    def user_id_from_username(self, name: str) -> str:
        return name + "_pk"

    def user_feed(self, user_id: str, amount: int = 0) -> list[Any]:
        return [
            SimpleNamespace(
                pk="1",
                code="aaa",
                caption_text="hello world",
                user=SimpleNamespace(username="alice"),
                media_type=1,
            ),
            SimpleNamespace(
                pk="2",
                code="bbb",
                caption_text="second post",
                user=SimpleNamespace(username="bob"),
                media_type=1,
            ),
        ]


def test_feed_list_returns_serializable_dicts(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient()
    sess = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")
    out = h["feed/list"](None)
    assert out == {"items": [
        {
            "pk": "1",
            "code": "aaa",
            "author": "alice",
            "caption": "hello world",
            "url": "https://www.instagram.com/p/aaa/",
        },
        {
            "pk": "2",
            "code": "bbb",
            "author": "bob",
            "caption": "second post",
            "url": "https://www.instagram.com/p/bbb/",
        },
    ]}


def test_login_handler_round_trips_through_IGSession(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")
    out = h["login"]({"username": "u", "password": "p"})
    assert out == {"status": "ready", "message": None}
    assert client.username_seen == "u"


def test_validate_handler_returns_login_required_when_no_session(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "missing.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="alice")
    out = h["validate"](None)
    assert out == {"status": "login_required", "message": None}
