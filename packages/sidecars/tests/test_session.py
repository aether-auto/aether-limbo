"""Tests for IGSession with a hand-rolled fake instagrapi.Client."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from limbo_sidecars.instagram.session import IGSession, LoginResult


class FakeClient:
    def __init__(self) -> None:
        self.settings: dict[str, Any] = {}
        self.dump_calls: list[Path] = []
        self.load_calls: list[Path] = []
        self.smoke_called: bool = False
        self.raise_on_login: Exception | None = None
        self.raise_on_smoke: Exception | None = None
        self.username_seen: str | None = None

    def load_settings(self, path: Path) -> None:
        self.load_calls.append(path)
        self.settings = json.loads(Path(path).read_text())

    def dump_settings(self, path: Path) -> None:
        self.dump_calls.append(path)
        Path(path).write_text(json.dumps(self.settings))

    def login(self, username: str, password: str, verification_code: str | None = None) -> bool:
        self.username_seen = username
        if self.raise_on_login is not None:
            err = self.raise_on_login
            self.raise_on_login = None
            raise err
        self.settings = {"sessionid": "fake"}
        return True

    def get_timeline_feed(self) -> dict[str, Any]:
        self.smoke_called = True
        if self.raise_on_smoke is not None:
            raise self.raise_on_smoke
        return {"feed_items": []}


class TwoFactorRequired(Exception):
    """Stand-in for instagrapi.exceptions.TwoFactorRequired."""


def test_validate_returns_ready_when_session_loads_and_smoke_passes(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="ready", message=None)
    assert client.load_calls == [session_path]
    assert client.smoke_called is True


def test_validate_returns_login_required_when_no_session_file(tmp_path: Path) -> None:
    session_path = tmp_path / "missing.json"
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="login_required", message=None)
    assert client.load_calls == []


def test_validate_returns_login_required_when_smoke_check_throws(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient()
    client.raise_on_smoke = Exception("session expired")
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="login_required", message="session expired")


def test_login_with_credentials_persists_session(tmp_path: Path) -> None:
    session_path = tmp_path / "subdir" / "instagram.json"  # parent does not exist yet
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw")
    assert result == LoginResult(status="ready", message=None)
    assert client.username_seen == "alice"
    assert client.dump_calls == [session_path]
    assert json.loads(session_path.read_text())["sessionid"] == "fake"


def test_login_returns_2fa_required_when_client_throws_TwoFactorRequired(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = TwoFactorRequired()
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw")
    assert result == LoginResult(status="2fa_required", message=None)


def test_login_with_2fa_code_completes_when_provided(tmp_path: Path) -> None:
    client = FakeClient()
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw", code="123456")
    assert result == LoginResult(status="ready", message=None)


def test_login_returns_failed_with_message_on_unknown_exception(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = ValueError("incorrect password")
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="wrong")
    assert result == LoginResult(status="failed", message="incorrect password")
