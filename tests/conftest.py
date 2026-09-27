"""Shared test isolation."""
import os

import pytest


@pytest.fixture(autouse=True)
def restore_environ():
    """Put os.environ back after each test.

    `read_settings()` calls `load_dotenv()`, which walks up from the repo and can load a parent
    checkout's `.env` (a git worktree sits inside the main clone). Without this, SUPABASE_* keys
    set by one test leak into later ones, and API tests that fake `requests.get` then see a
    real /runs call.
    """
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)
