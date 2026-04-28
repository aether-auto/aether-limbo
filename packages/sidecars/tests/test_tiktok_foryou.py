"""Alias module so `pytest tests/test_tiktok_foryou.py` resolves correctly.

All tests live in test_tiktok_foryou_handlers.py; this file re-exports them
so both the short name used in PLAN.md verification commands and the canonical
name work interchangeably.
"""
from tests.test_tiktok_foryou_handlers import *  # noqa: F401, F403
