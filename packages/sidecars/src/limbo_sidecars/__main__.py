"""Sidecar dispatcher: `python -m limbo_sidecars <name>` runs that adapter."""
from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python -m limbo_sidecars <adapter>\n")
        return 64
    name = sys.argv[1]
    if name == "echo":
        from . import echo

        return echo.main()
    if name == "instagram":
        from .instagram import bundle

        return bundle.main()
    if name in ("instagram-reels", "instagram-feed", "instagram-dms"):
        sys.stderr.write(
            f"deprecated: '{name}' has been merged into 'instagram'. "
            "Use: python -m limbo_sidecars instagram\n"
        )
        from .instagram import bundle

        return bundle.main()
    if name == "twitter-home":
        from .twitter import home

        return home.main()
    if name == "tiktok-foryou":
        from .tiktok import foryou

        return foryou.main()
    sys.stderr.write(f"unknown adapter: {name}\n")
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
