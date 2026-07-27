"""Tests for twscrape_account_status — the explicit health check added
because fetch_twitter_comments() swallows login/auth failures at DEBUG level
by design (best-effort). Without this, expired twscrape cookies (which
happens every 2-4 weeks) produce zero visible errors anywhere.

Deliberately does a live search rather than trusting accounts_info()'s
"logged_in" field: that flag only reflects twscrape's username/password
login flow and reads False permanently for this project's cookie-injected
accounts, even when the cookies are fully functional (verified directly
against a real account during development — see refresh_twitter.py)."""
from __future__ import annotations

import sys
import types

from harvester.social import twscrape_account_status


class _FakePool:
    def __init__(self, accounts):
        self._accounts = accounts

    async def accounts_info(self):
        return self._accounts


class _FakeAPI:
    def __init__(self, db_path, accounts=None, tweets=None, search_error=None):
        self.pool = _FakePool(accounts if accounts is not None else [{"username": "a"}])
        self._tweets = tweets or []
        self._search_error = search_error

    async def search(self, query, limit=1):
        if self._search_error:
            raise self._search_error
        for t in self._tweets:
            yield t


def _install_fake_twscrape(monkeypatch, **kwargs):
    fake_module = types.ModuleType("twscrape")
    fake_module.API = lambda db_path: _FakeAPI(db_path, **kwargs)
    monkeypatch.setitem(sys.modules, "twscrape", fake_module)


def test_no_db_returns_no_db(tmp_path):
    missing = tmp_path / "does_not_exist.db"

    assert twscrape_account_status(str(missing)) == "no_db"


def test_ok_when_search_returns_a_result(tmp_path, monkeypatch):
    db = tmp_path / "accounts.db"
    db.write_text("")
    _install_fake_twscrape(monkeypatch, tweets=[object()])

    assert twscrape_account_status(str(db)) == "ok"


def test_ok_when_search_returns_zero_results(tmp_path, monkeypatch):
    """Zero matches is still a valid authenticated response -- must not be
    confused with an auth failure."""
    db = tmp_path / "accounts.db"
    db.write_text("")
    _install_fake_twscrape(monkeypatch, tweets=[])

    assert twscrape_account_status(str(db)) == "ok"


def test_auth_failed_when_search_raises(tmp_path, monkeypatch):
    db = tmp_path / "accounts.db"
    db.write_text("")
    _install_fake_twscrape(monkeypatch, search_error=RuntimeError("401 Unauthorized"))

    assert twscrape_account_status(str(db)) == "auth_failed"


def test_no_accounts_when_pool_is_empty(tmp_path, monkeypatch):
    db = tmp_path / "accounts.db"
    db.write_text("")
    _install_fake_twscrape(monkeypatch, accounts=[])

    assert twscrape_account_status(str(db)) == "no_accounts"
