"""Tests for TikTokSession with a hand-rolled fake TikTokApi."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from limbo_sidecars.tiktok.session import LoginResult, TikTokSession


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


class FakeTikTokApi:
    def __init__(self) -> None:
        self.create_sessions_calls: list[dict[str, Any]] = []
        self.close_sessions_calls: int = 0
        self.raise_on_create: Optional[Exception] = None

    async def create_sessions(
        self, *, ms_tokens: list[str], num_sessions: int = 1
    ) -> dict[str, Any]:
        self.create_sessions_calls.append(
            {"ms_tokens": ms_tokens, "num_sessions": num_sessions}
        )
        if self.raise_on_create is not None:
            err = self.raise_on_create
            self.raise_on_create = None
            raise err
        return {"sessions": num_sessions}

    async def close_sessions(self) -> None:
        self.close_sessions_calls += 1


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_validate_returns_login_required_when_session_file_absent(tmp_path: Path) -> None:
    """Test 1: validate() returns LoginResult("login_required", None) when session file is absent."""
    session_path = tmp_path / "tiktok.json"
    client = FakeTikTokApi()
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    result = s.validate()
    assert result == LoginResult(status="login_required", message=None)
    assert client.create_sessions_calls == []


def test_set_token_writes_json_with_correct_mode(tmp_path: Path) -> None:
    """Test 2: set_token writes {"ms_token": token} to disk with mode 0600."""
    session_path = tmp_path / "tiktok.json"
    client = FakeTikTokApi()
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    s.set_token("eyJhbGc")
    assert session_path.exists()
    data = json.loads(session_path.read_text())
    assert data == {"ms_token": "eyJhbGc"}
    assert os.stat(session_path).st_mode & 0o777 == 0o600


def test_set_token_calls_create_sessions_once(tmp_path: Path) -> None:
    """Test 3: set_token calls client.create_sessions(ms_tokens=[token], num_sessions=1) exactly once."""
    session_path = tmp_path / "tiktok.json"
    client = FakeTikTokApi()
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    s.set_token("eyJhbGc")
    assert len(client.create_sessions_calls) == 1
    call = client.create_sessions_calls[0]
    assert call["ms_tokens"] == ["eyJhbGc"]
    assert call["num_sessions"] == 1


def test_validate_after_set_token_returns_ready(tmp_path: Path) -> None:
    """Test 4: validate() after set_token returns ("ready", None) and calls create_sessions once per call."""
    session_path = tmp_path / "tiktok.json"
    client = FakeTikTokApi()
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)

    set_result = s.set_token("eyJhbGc")
    assert set_result == LoginResult(status="ready", message=None)
    assert len(client.create_sessions_calls) == 1

    validate_result = s.validate()
    assert validate_result == LoginResult(status="ready", message=None)
    # set_token call + validate call = 2 total
    assert len(client.create_sessions_calls) == 2


def test_validate_returns_login_required_when_create_sessions_raises(tmp_path: Path) -> None:
    """Test 5: validate() returns ("login_required", str(exc)) if create_sessions raises."""
    session_path = tmp_path / "tiktok.json"
    # Write a valid token file first so validate() proceeds past the file-exists check.
    session_path.write_text(json.dumps({"ms_token": "eyJhbGc"}))
    client = FakeTikTokApi()
    client.raise_on_create = Exception("session expired")
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    result = s.validate()
    assert result == LoginResult(status="login_required", message="session expired")


def test_set_token_returns_failed_when_create_sessions_raises(tmp_path: Path) -> None:
    """Test 6: set_token returns ("failed", str(exc)) if create_sessions raises."""
    session_path = tmp_path / "tiktok.json"
    client = FakeTikTokApi()
    client.raise_on_create = RuntimeError("network error")
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    result = s.set_token("eyJhbGc")
    assert result == LoginResult(status="failed", message="network error")


def test_set_token_creates_parent_dirs_automatically(tmp_path: Path) -> None:
    """Test 8: set_token auto-creates parent directories if missing."""
    session_path = tmp_path / "deeper" / "dir" / "tiktok.json"
    client = FakeTikTokApi()
    s = TikTokSession(client=client, session_path=session_path, runner=sync_runner)
    result = s.set_token("eyJhbGc")
    assert result == LoginResult(status="ready", message=None)
    assert session_path.exists()
    data = json.loads(session_path.read_text())
    assert data == {"ms_token": "eyJhbGc"}
    assert os.stat(session_path).st_mode & 0o777 == 0o600
