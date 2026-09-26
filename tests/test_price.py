"""Live NP6-905-CD price reader. The network is faked; no test calls ERCOT."""
import json
from datetime import datetime
from pathlib import Path

import requests

from server.engine.signal import CENTRAL, SignalUnavailable, fetch_price, read_price, stamp_price

PRICE_FIXTURE = Path(__file__).parent / "fixtures" / "np6_905_cd.json"
NOW = datetime(2026, 9, 25, 12, 0, 47, tzinfo=CENTRAL)
SECRETS = {"ERCOT_USERNAME": "user-SECRET-1", "ERCOT_PASSWORD": "pass-SECRET-2",
           "ERCOT_SUBSCRIPTION_KEY": "key-SECRET-3"}
TOKEN = "token-SECRET-4"
SETTINGS = {"fetch_timeout_s": 3}


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_read_price_picks_newest_settlement_point_price():
    raw = json.loads(PRICE_FIXTURE.read_text())
    price = read_price(raw, NOW)
    assert price["usd_mwh"] == 42.25
    assert price["delivery_date"] == "2026-09-25"
    assert (price["delivery_hour"], price["delivery_interval"]) == (12, 4)
    assert price["as_of"].startswith("2026-09-25T12:00:00")


def test_read_price_rejects_a_stale_interval():
    raw = {
        "fields": [{"name": name} for name in
                   ("deliveryDate", "deliveryHour", "deliveryInterval", "settlementPointPrice")],
        "data": [["2026-09-25", 10, 1, 30.0]],
    }
    try:
        read_price(raw, NOW)
    except SignalUnavailable as exc:
        assert "min old" in str(exc)
    else:
        raise AssertionError("stale interval should be unavailable")


def test_fetch_price_asks_lz_north_with_the_token_helper(monkeypatch, tmp_path):
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.chdir(tmp_path)
    calls = []

    def post(url, **kwargs):
        calls.append(("post", url, kwargs))
        return FakeResponse(200, json.dumps({"id_token": TOKEN}))

    def get(url, **kwargs):
        calls.append(("get", url, kwargs))
        return FakeResponse(200, PRICE_FIXTURE.read_text())

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)

    saved = tmp_path / "latest_np6.json"
    raw = fetch_price(SETTINGS, NOW, save_to=saved)
    assert raw["report"]["reportEMIL"] == "NP6-905-CD"
    assert saved.read_text() == PRICE_FIXTURE.read_text()
    _method, url, kwargs = calls[1]
    assert url.endswith("/np6-905-cd/spp_node_zone_hub")
    assert kwargs["params"]["settlementPoint"] == "LZ_NORTH"
    assert kwargs["headers"] == {"Authorization": f"Bearer {TOKEN}",
                                 "Ocp-Apim-Subscription-Key": SECRETS["ERCOT_SUBSCRIPTION_KEY"]}
    assert kwargs["timeout"] == 3
    assert "NP4-190" not in url


def test_stamp_price_sets_ercot_fields_and_clears_185_on_failure():
    tape = {"price_usd_mwh": 185, "price_label": "synthetic", "target_mw": 0.4}
    ok = stamp_price(tape, {"usd_mwh": 42.25, "as_of": "2026-09-25T12:00:00-05:00"})
    assert ok["price_usd_mwh"] == 42.25
    assert ok["price_label"] == "ercot"
    assert ok["price_as_of"] == "2026-09-25T12:00:00-05:00"
    assert ok["target_mw"] == 0.4
    failed = stamp_price(tape, None)
    assert failed["price_usd_mwh"] is None
    assert failed["price_label"] == "none"
    assert failed["price_as_of"] is None
    assert 185 not in failed.values()
