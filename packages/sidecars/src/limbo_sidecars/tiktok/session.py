"""TikTokSession — thin wrapper around an injected TikTokApi instance.

TikTokApi is an optional dependency (``tiktok`` extra). It is never imported
at module level here so that the stdlib-only unit tests can import this module
without TikTokApi installed.

The session token (``ms_token``) is persisted as JSON to disk at mode 0600.
Because ``pathlib.Path.write_text`` does not change permissions on an existing
file, we use ``os.open`` with explicit mode flags so the guarantee holds even
on overwrites.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Protocol


class TikTokApiProtocol(Protocol):
    async def create_sessions(
        self, *, ms_tokens: list[str], num_sessions: int = 1
    ) -> Any: ...

    async def close_sessions(self) -> Any: ...


@dataclass(frozen=True)
class LoginResult:
    status: str  # "ready" | "login_required" | "failed"
    message: Optional[str]


# A "runner" turns a coroutine into a synchronous result. asyncio.run is the
# production default; tests inject a coroutine driver that doesn't open a loop.
Runner = Callable[[Awaitable[Any]], Any]


def _write_token_file(path: Path, data: str) -> None:
    """Write *data* to *path* at mode 0600 regardless of whether the file exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
    except Exception:
        # fd is closed by os.fdopen; re-raise without leaking
        raise
    # Defensive chmod in case the file already existed (open re-uses inode).
    os.chmod(str(path), 0o600)


class TikTokSession:
    def __init__(
        self,
        *,
        client: TikTokApiProtocol,
        session_path: Path,
        runner: Runner = asyncio.run,
    ) -> None:
        self._client = client
        self._session_path = session_path
        self._runner = runner

    @property
    def client(self) -> TikTokApiProtocol:
        return self._client

    def validate(self) -> LoginResult:
        """Check whether the stored ms_token is still usable.

        Returns ``login_required`` (message=None) when the session file is
        absent.  Reads the ``ms_token`` from disk, calls
        ``create_sessions(ms_tokens=[token], num_sessions=1)``.  On any
        exception returns ``login_required`` with the exception message.  On
        success returns ``ready``.
        """
        if not self._session_path.exists():
            return LoginResult(status="login_required", message=None)

        try:
            payload: dict[str, Any] = json.loads(self._session_path.read_text())
            token: str = payload["ms_token"]
            self._runner(
                self._client.create_sessions(ms_tokens=[token], num_sessions=1)
            )
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            return LoginResult(status="login_required", message=str(exc))

        return LoginResult(status="ready", message=None)

    def set_token(self, token: str) -> LoginResult:
        """Persist *token* to disk (mode 0600) then activate a session.

        Writes ``{"ms_token": token}`` as JSON to ``session_path``, creating
        parent directories as needed.  Then calls
        ``create_sessions(ms_tokens=[token], num_sessions=1)``.  On exception
        in ``create_sessions`` returns ``("failed", str(exc))``.  On success
        returns ``("ready", None)``.
        """
        _write_token_file(self._session_path, json.dumps({"ms_token": token}))

        try:
            self._runner(
                self._client.create_sessions(ms_tokens=[token], num_sessions=1)
            )
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            return LoginResult(status="failed", message=str(exc))

        return LoginResult(status="ready", message=None)
