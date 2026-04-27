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
    if name == "instagram-reels":
        from .instagram import reels

        return reels.main()
    sys.stderr.write(f"unknown adapter: {name}\n")
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
