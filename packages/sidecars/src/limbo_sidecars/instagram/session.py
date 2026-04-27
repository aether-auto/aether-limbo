"""IGSession — thin wrapper around an injected instagrapi.Client.

Instagrapi is an optional dependency (``instagram`` extra). It is never
imported at module level here so that the stdlib-only unit tests can import
this module without instagrapi installed.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol


class IGClientProtocol(Protocol):
    def load_settings(self, path: Path) -> None: ...
    def dump_settings(self, path: Path) -> None: ...
    def login(self, username: str, password: str, verification_code: Optional[str] = None) -> bool: ...
    def get_timeline_feed(self) -> Any: ...


@dataclass(frozen=True)
class LoginResult:
    status: str  # "ready" | "login_required" | "2fa_required" | "failed"
    message: Optional[str]


class IGSession:
    def __init__(
        self,
        *,
        client: IGClientProtocol,
        session_path: Path,
        two_factor_exc: type[BaseException],
    ) -> None:
        self._client = client
        self._session_path = session_path
        self._two_factor_exc = two_factor_exc

    @property
    def client(self) -> IGClientProtocol:
        return self._client

    def validate(self) -> LoginResult:
        """Check whether the stored session is still alive.

        Returns ``ready`` if the session file exists and the smoke check passes.
        Returns ``login_required`` (with ``message=None``) when the file is
        absent, or with the exception message when the smoke check throws.
        """
        if not self._session_path.exists():
            return LoginResult(status="login_required", message=None)

        try:  # noqa: BLE001
            self._client.load_settings(self._session_path)
            self._client.get_timeline_feed()
        except Exception as exc:  # noqa: BLE001
            return LoginResult(status="login_required", message=str(exc))

        return LoginResult(status="ready", message=None)

    def login(self, *, username: str, password: str, code: Optional[str] = None) -> LoginResult:
        """Attempt a fresh login, persisting the session on success."""
        try:  # noqa: BLE001
            self._client.login(username, password, verification_code=code)
        except self._two_factor_exc:  # type: ignore[misc]
            return LoginResult(status="2fa_required", message=None)
        except Exception as exc:  # noqa: BLE001
            return LoginResult(status="failed", message=str(exc))

        self._session_path.parent.mkdir(parents=True, exist_ok=True)
        self._client.dump_settings(self._session_path)
        return LoginResult(status="ready", message=None)
