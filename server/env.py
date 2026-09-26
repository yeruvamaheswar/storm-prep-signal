"""One env loader for scripts and FastAPI.

Reads `server/.env` first. Process env (Render, the shell) already set in
`os.environ` is left in place, so it wins. Do not put these names in Vite.
"""

from pathlib import Path

from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent / ".env"


def load_env(path=None):
    """Fill missing keys from `server/.env`. Already-set process env stays."""
    load_dotenv(path or ENV_PATH, override=False)
