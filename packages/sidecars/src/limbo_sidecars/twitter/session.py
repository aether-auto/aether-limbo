"""TwitterSession — thin wrapper around an injected twikit.Client.

twikit is an optional dependency (``twitter`` extra). It is never imported at
module level here so that the stdlib-only unit tests can import this module
without twikit installed.

Diverges from IGSession in three ways:
1. twikit auth uses cookies (``save_cookies`` / ``load_cookies``), not the
   instagrapi settings dump.
2. twikit's API is async-only, so every call is wrapped via the injected
   ``runner`` (defaults to ``asyncio.run``). Tests pass a synchronous runner
   that drives the coroutine without an event loop.
3. twikit does not have a discrete ``TwoFactorRequired`` exception — instead
   it raises generic auth errors whose message mentions the challenge type.
   We classify failed-login messages heuristically; the form's 2FA branch
   re-submits the same login with a code in the ``code`` slot.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Protocol


class TwitterClientProtocol(Protocol):
    def save_cookies(self, path: Path) -> None: ...
    def load_cookies(self, path: Path) -> None: ...
    def login(
        self,
        *,
        auth_info_1: str,
        password: str,
        totp_secret: Optional[str] = None,
    ) -> Awaitable[Any]: ...
    def user(self) -> Awaitable[Any]: ...


@dataclass(frozen=True)
class LoginResult:
    status: str  # "ready" | "login_required" | "2fa_required" | "failed"
    message: Optional[str]


# A "runner" turns a coroutine into a synchronous result. asyncio.run is the
# production default; tests inject a coroutine driver that doesn't open a loop.
Runner = Callable[[Awaitable[Any]], Any]


_TWO_FACTOR_HINTS = (
    "verification",
    "two-factor",
    "two factor",
    "2fa",
    "totp",
    "challenge",
)


def _looks_like_2fa(message: str) -> bool:
    low = message.lower()
    return any(h in low for h in _TWO_FACTOR_HINTS)


class TwitterSession:
    def __init__(
        self,
        *,
        client: TwitterClientProtocol,
        session_path: Path,
        runner: Runner = asyncio.run,
    ) -> None:
        self._client = client
        self._session_path = session_path
        self._runner = runner

    @property
    def client(self) -> TwitterClientProtocol:
        return self._client

    def validate(self) -> LoginResult:
        """Check whether the stored cookie jar is still alive.

        Returns ``ready`` if the session file exists and the smoke check
        (an authenticated ``user()`` call) passes. Returns ``login_required``
        when the file is absent, or with the exception message when the smoke
        check throws.
        """
        if not self._session_path.exists():
            return LoginResult(status="login_required", message=None)

        try:
            self._client.load_cookies(self._session_path)
            self._runner(self._client.user())
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            return LoginResult(status="login_required", message=str(exc))

        return LoginResult(status="ready", message=None)

    def login(
        self, *, username: str, password: str, code: Optional[str] = None
    ) -> LoginResult:
        """Attempt a fresh login, persisting cookies on success.

        ``code`` is forwarded to twikit's ``totp_secret`` slot. Empty / None
        means the caller hasn't been prompted for 2FA yet.
        """
        try:
            self._runner(
                self._client.login(
                    auth_info_1=username,
                    password=password,
                    totp_secret=code or None,
                )
            )
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            msg = str(exc)
            if _looks_like_2fa(msg) and not code:
                return LoginResult(status="2fa_required", message=msg)
            return LoginResult(status="failed", message=msg)

        self._session_path.parent.mkdir(parents=True, exist_ok=True)
        self._client.save_cookies(self._session_path)
        return LoginResult(status="ready", message=None)
