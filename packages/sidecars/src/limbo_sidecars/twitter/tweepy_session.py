"""TweepySession — Twitter/X backend using the tweepy library.

tweepy is an optional dependency (``twitter-tweepy`` extra). It is never imported
at module level here so that stdlib-only unit tests can import this module without
tweepy installed.

Auth model:
- v2 read-only: TWITTER_BEARER_TOKEN  → tweepy.Client
- v1.1 actions (like, reply): TWITTER_API_KEY, TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET → tweepy.OAuth1UserHandler + tweepy.API
- DMs: v1.1 API, paid-tier only — degrade gracefully.

The public method shape matches TwitterSession so build_handlers() can accept
either session type without modification.
"""
from __future__ import annotations

import importlib
import os
from typing import Any, Optional


_REQUIRED_BEARER = ("TWITTER_BEARER_TOKEN",)
_REQUIRED_V1 = (
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_SECRET",
)


class TweepySession:
    """Tweepy-backed session satisfying the same public interface as TwitterSession.

    Parameters
    ----------
    tweepy_module:
        The tweepy module (or a test fake). Defaults to a lazy import of
        ``tweepy`` so the real library is never imported at module load time.
    """

    def __init__(self, *, tweepy_module: Any = None) -> None:
        self._tweepy_module: Any = tweepy_module  # resolved on first access

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _tweepy(self) -> Any:
        if self._tweepy_module is None:
            self._tweepy_module = importlib.import_module("tweepy")
        return self._tweepy_module

    def _bearer_token(self) -> Optional[str]:
        return os.environ.get("TWITTER_BEARER_TOKEN")

    def _v1_creds(self) -> Optional[tuple[str, str, str, str]]:
        api_key = os.environ.get("TWITTER_API_KEY")
        api_secret = os.environ.get("TWITTER_API_SECRET")
        access_token = os.environ.get("TWITTER_ACCESS_TOKEN")
        access_secret = os.environ.get("TWITTER_ACCESS_SECRET")
        if api_key and api_secret and access_token and access_secret:
            return api_key, api_secret, access_token, access_secret
        return None

    def _client_v2(self) -> Any:
        """Return a tweepy.Client configured for v2 read operations."""
        tw = self._tweepy()
        return tw.Client(bearer_token=self._bearer_token())

    def _api_v1(self) -> Any:
        """Return a tweepy.API configured for v1.1 actions."""
        tw = self._tweepy()
        creds = self._v1_creds()
        if creds is None:
            raise RuntimeError("v1.1 credentials not set")
        api_key, api_secret, access_token, access_secret = creds
        auth = tw.OAuth1UserHandler(api_key, api_secret, access_token, access_secret)
        return tw.API(auth)

    # ------------------------------------------------------------------
    # Public interface (mirrors TwitterSession)
    # ------------------------------------------------------------------

    def validate(self) -> dict[str, Any]:
        """Check that required env vars are present.

        Returns ``{"status": "ok"}`` when at least the bearer token is set,
        ``{"status": "needs_auth"}`` otherwise.
        """
        if self._bearer_token():
            return {"status": "ok"}
        return {"status": "needs_auth"}

    def login(self, username: str = "", password: str = "") -> dict[str, Any]:
        """No-op for tweepy: auth is API-key based, not credential-based.

        Returns ok if the bearer token env var is present, missing_keys otherwise.
        The ``username`` / ``password`` parameters are accepted for interface
        compatibility but are not used.
        """
        if self._bearer_token():
            return {"status": "ok"}
        missing = [v for v in _REQUIRED_BEARER if not os.environ.get(v)]
        return {
            "status": "missing_keys",
            "message": f"Missing env vars: {', '.join(missing)}",
        }

    def login_2fa(self, code: str = "") -> dict[str, Any]:  # noqa: ARG002
        """No-op for tweepy bearer-token flow."""
        return {"status": "ok"}

    def home_timeline(self, limit: int = 20) -> list[dict[str, Any]]:
        """Fetch recent home-timeline tweets via v2 Client.

        Returns a list of ``{id, author, text, url}`` dicts matching the
        existing twikit serialisation shape used by build_handlers().
        """
        client = self._client_v2()
        # expansions and fields required to get author data back
        response = client.get_home_timeline(
            max_results=min(limit, 100),
            expansions=["author_id"],
            user_fields=["username"],
        )

        tweets = response.data or []
        users_by_id: dict[str, str] = {}
        if response.includes and "users" in response.includes:
            for u in response.includes["users"]:
                users_by_id[str(u.id)] = str(u.username)

        items: list[dict[str, Any]] = []
        for t in tweets:
            tweet_id = str(t.id)
            author = users_by_id.get(str(t.author_id), "")
            text = str(t.text or "")
            url = f"https://x.com/{author}/status/{tweet_id}" if author and tweet_id else ""
            items.append({"id": tweet_id, "author": author, "text": text, "url": url})
        return items

    def like(self, tweet_id: str) -> dict[str, Any]:
        """Like a tweet via v2 Client."""
        try:
            # v2 like requires an authenticated user id; we use the me() call
            client = self._client_v2()
            me = client.get_me()
            if me is None or me.data is None:
                return {"ok": False, "message": "Could not resolve authenticated user"}
            client.like(me.data.id, tweet_id)
            return {"ok": True}
        except Exception as err:  # noqa: BLE001 — protocol boundary
            return {"ok": False, "message": str(err)}

    def reply(self, tweet_id: str, text: str) -> dict[str, Any]:
        """Reply to a tweet via v2 Client."""
        try:
            client = self._client_v2()
            client.create_tweet(text=text, in_reply_to_tweet_id=tweet_id)
            return {"ok": True}
        except Exception as err:  # noqa: BLE001 — protocol boundary
            return {"ok": False, "message": str(err)}

    def dm_threads(self) -> dict[str, Any]:
        """List DM threads via v1.1 API; degrades gracefully on access errors."""
        try:
            api = self._api_v1()
            # direct_messages endpoint — returns list of DirectMessage objects
            messages = api.get_direct_messages()
            # Group by sender to simulate threads
            threads: dict[str, dict[str, Any]] = {}
            for m in messages:
                sender_id = str(getattr(m, "sender_id", ""))
                if sender_id not in threads:
                    threads[sender_id] = {
                        "thread_id": sender_id,
                        "title": str(
                            getattr(m, "sender_screen_name", "")
                            or getattr(m, "sender_id", "")
                        ),
                        "last_message": str(getattr(m, "text", "") or ""),
                    }
            return {"available": True, "items": list(threads.values())}
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            return {"available": False, "items": [], "message": str(err)}

    def dm_messages(self, thread_id: str) -> dict[str, Any]:
        """List messages for a DM thread; degrades gracefully on access errors."""
        try:
            api = self._api_v1()
            messages = api.get_direct_messages()
            items = []
            for m in messages:
                sender_id = str(getattr(m, "sender_id", ""))
                if sender_id == thread_id:
                    items.append(
                        {
                            "from": sender_id,
                            "text": str(getattr(m, "text", "") or ""),
                            "ts": str(getattr(m, "created_at", "") or ""),
                        }
                    )
            return {"available": True, "items": items}
        except Exception as err:  # noqa: BLE001 — paid-tier degradation
            return {"available": False, "items": [], "message": str(err)}
