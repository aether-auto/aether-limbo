"""Tests for TwitterSession with a hand-rolled fake twikit.Client."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from limbo_sidecars.twitter.session import LoginResult, TwitterSession


# ---------------------------------------------------------------------------
# sync_runner — drives a coroutine without opening an event loop
# ---------------------------------------------------------------------------
def sync_runner(coro: Any) -> Any:
    """Run an awaitable synchronously by ``send``-ing once.

    Works for our FakeClient where every async method either returns a value
    immediately or raises immediately — no real awaiting happens.
    """
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value


class FakeClient:
    def __init__(self) -> None:
        self.cookies: dict[str, Any] = {}
        self.save_calls: list[Path] = []
        self.load_calls: list[Path] = []
        self.user_calls: int = 0
        self.raise_on_login: Optional[Exception] = None
        self.raise_on_smoke: Optional[Exception] = None
        self.username_seen: Optional[str] = None
        self.totp_seen: Optional[str] = None

    def load_cookies(self, path: Path) -> None:
        self.load_calls.append(path)
        self.cookies = json.loads(Path(path).read_text())

    def save_cookies(self, path: Path) -> None:
        self.save_calls.append(path)
        Path(path).write_text(json.dumps(self.cookies))

    async def login(
        self,
        *,
        auth_info_1: str,
        password: str,
        totp_secret: Optional[str] = None,
    ) -> bool:
        self.username_seen = auth_info_1
        self.totp_seen = totp_secret
        if self.raise_on_login is not None:
            err = self.raise_on_login
            self.raise_on_login = None
            raise err
        self.cookies = {"auth_token": "fake"}
        return True

    async def user(self) -> dict[str, Any]:
        self.user_calls += 1
        if self.raise_on_smoke is not None:
            raise self.raise_on_smoke
        return {"screen_name": "alice"}


def test_validate_returns_ready_when_session_loads_and_smoke_passes(tmp_path: Path) -> None:
    session_path = tmp_path / "twitter.json"
    session_path.write_text(json.dumps({"auth_token": "x"}))
    client = FakeClient()
    s = TwitterSession(client=client, session_path=session_path, runner=sync_runner)
    assert s.validate() == LoginResult(status="ready", message=None)
    assert client.load_calls == [session_path]
    assert client.user_calls == 1


def test_validate_returns_login_required_when_no_session_file(tmp_path: Path) -> None:
    session_path = tmp_path / "missing.json"
    client = FakeClient()
    s = TwitterSession(client=client, session_path=session_path, runner=sync_runner)
    assert s.validate() == LoginResult(status="login_required", message=None)
    assert client.load_calls == []


def test_validate_returns_login_required_when_smoke_check_throws(tmp_path: Path) -> None:
    session_path = tmp_path / "twitter.json"
    session_path.write_text(json.dumps({"auth_token": "x"}))
    client = FakeClient()
    client.raise_on_smoke = Exception("session expired")
    s = TwitterSession(client=client, session_path=session_path, runner=sync_runner)
    assert s.validate() == LoginResult(status="login_required", message="session expired")


def test_login_with_credentials_persists_cookies(tmp_path: Path) -> None:
    session_path = tmp_path / "subdir" / "twitter.json"  # parent does not exist
    client = FakeClient()
    s = TwitterSession(client=client, session_path=session_path, runner=sync_runner)
    result = s.login(username="alice", password="pw")
    assert result == LoginResult(status="ready", message=None)
    assert client.username_seen == "alice"
    assert client.totp_seen is None
    assert client.save_calls == [session_path]
    assert json.loads(session_path.read_text())["auth_token"] == "fake"


def test_login_returns_2fa_required_on_verification_message(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = RuntimeError("Account requires verification challenge")
    s = TwitterSession(
        client=client, session_path=tmp_path / "twitter.json", runner=sync_runner
    )
    result = s.login(username="alice", password="pw")
    assert result.status == "2fa_required"


def test_login_2fa_code_passed_as_totp_secret(tmp_path: Path) -> None:
    client = FakeClient()
    s = TwitterSession(
        client=client, session_path=tmp_path / "twitter.json", runner=sync_runner
    )
    result = s.login(username="alice", password="pw", code="123456")
    assert result == LoginResult(status="ready", message=None)
    assert client.totp_seen == "123456"


def test_login_returns_failed_on_unknown_exception(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = ValueError("incorrect password")
    s = TwitterSession(
        client=client, session_path=tmp_path / "twitter.json", runner=sync_runner
    )
    result = s.login(username="alice", password="wrong")
    assert result == LoginResult(status="failed", message="incorrect password")


def test_login_with_code_does_not_loop_on_2fa_message(tmp_path: Path) -> None:
    """If the user supplies a code AND twikit still complains about verification,
    we must not re-prompt — that would be an infinite loop. Treat as failed."""
    client = FakeClient()
    client.raise_on_login = RuntimeError("verification still required")
    s = TwitterSession(
        client=client, session_path=tmp_path / "twitter.json", runner=sync_runner
    )
    result = s.login(username="alice", password="pw", code="000000")
    assert result.status == "failed"
