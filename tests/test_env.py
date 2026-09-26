"""server/env.py: server/.env then process env. No secrets in the assertions."""
import importlib.util
import os
from pathlib import Path

from server.api.feeds import fetch_settings
from server.api.fixtures import FixtureStore
from server.app import create_app
from server.env import ENV_PATH, load_env

ROOT = Path(__file__).resolve().parent.parent


def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_path_is_server_dotenv():
    assert ENV_PATH == ROOT / "server" / ".env"


def test_scripts_share_the_server_env_path():
    archive = _load_script("load_ercot_archive")
    reports = _load_script("load_ercot_reports")
    check = _load_script("check_margin")
    persist = _load_script("persist_run")
    assert archive.ENV_PATH == ENV_PATH
    assert reports.ENV_PATH == ENV_PATH
    assert check.ENV_PATH == ENV_PATH
    assert persist.ENV_PATH == ENV_PATH


def test_file_fills_missing_keys(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("SUPABASE_URL=from-file\n")
    monkeypatch.delenv("SUPABASE_URL", raising=False)

    load_env(path)

    assert os.environ["SUPABASE_URL"] == "from-file"


def test_process_env_wins_over_file(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("SUPABASE_URL=from-file\n")
    monkeypatch.setenv("SUPABASE_URL", "from-process")

    load_env(path)

    assert os.environ["SUPABASE_URL"] == "from-process"


def test_missing_file_leaves_process_env(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)

    load_env(tmp_path / "missing.env")

    assert "SUPABASE_URL" not in os.environ


def test_create_app_calls_shared_loader(monkeypatch):
    called = []
    monkeypatch.setattr("server.app.load_env", lambda: called.append(True))

    create_app(FixtureStore())

    assert called == [True]


def test_fetch_settings_calls_shared_loader(monkeypatch):
    called = []
    monkeypatch.setattr("server.api.feeds.load_env", lambda: called.append(True))
    monkeypatch.setenv("FETCH_TIMEOUT_S", "7")

    assert fetch_settings() == {"fetch_timeout_s": 7.0}
    assert called == [True]
