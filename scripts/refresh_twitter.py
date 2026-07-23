"""
Refresh twscrape Twitter cookies from your logged-in browser session.

Two modes:

  Automatic (works on Firefox and older Chrome/Brave builds):
    python scripts/refresh_twitter.py --browser firefox

  Manual (works everywhere — takes ~10 seconds):
    1. Open x.com in your browser, press F12, go to Console, run:
         copy(document.cookie.split('; ').filter(c=>c.startsWith('auth_token')||c.startsWith('ct0')).join('; '))
    2. Run:
         python scripts/refresh_twitter.py --cookies "auth_token=xxx; ct0=yyy"

  Note: Chrome 127+ and Brave Nightly use App-Bound Encryption which blocks
  automated cookie reading from external processes. Use --cookies for those.

Default DB path matches the pipeline config: data/twscrape_accounts.db
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

_DEFAULT_DB = "data/twscrape_accounts.db"
_SUPPORTED_BROWSERS = ["chrome", "firefox", "edge", "chromium", "brave", "brave-nightly"]

# Chromium-based browsers with non-standard profile paths (browser-cookie3 doesn't know these).
# Each entry: (cookie_file, key_file) relative to %LOCALAPPDATA%.
_CUSTOM_PATHS: dict[str, tuple[str, str]] = {
    "brave-nightly": (
        r"BraveSoftware\Brave-Browser-Nightly\User Data\Default\Network\Cookies",
        r"BraveSoftware\Brave-Browser-Nightly\User Data\Local State",
    ),
    "edge": (
        r"Microsoft\Edge\User Data\Default\Network\Cookies",
        r"Microsoft\Edge\User Data\Local State",
    ),
}


def extract_cookies(browser: str) -> dict[str, str] | None:
    try:
        import browser_cookie3
    except ImportError:
        print("browser-cookie3 not installed. Run: pip install 'signal-harvester[twitter]'")
        return None

    try:
        if browser in _CUSTOM_PATHS:
            import os
            import shutil
            import tempfile
            local_app_data = os.environ.get("LOCALAPPDATA", "")
            cookie_rel, key_rel = _CUSTOM_PATHS[browser]
            cookie_file = os.path.join(local_app_data, cookie_rel)
            key_file = os.path.join(local_app_data, key_rel)
            if not os.path.exists(cookie_file):
                print(f"Cookie file not found: {cookie_file}")
                print(f"Is {browser} installed and have you visited x.com?")
                return None
            # Copy to temp file so we can read it while the browser is open
            tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
            tmp.close()
            shutil.copy2(cookie_file, tmp.name)
            try:
                jar = browser_cookie3.chrome(cookie_file=tmp.name, key_file=key_file, domain_name=".x.com")
            finally:
                os.unlink(tmp.name)
        else:
            loader = getattr(browser_cookie3, browser, None)
            if loader is None:
                print(f"Unsupported browser: {browser}. Choose from: {', '.join(_SUPPORTED_BROWSERS)}")
                return None
            jar = loader(domain_name=".x.com")
    except PermissionError:
        print(f"Permission denied reading {browser} cookies.")
        print("Close the browser and retry, or run as administrator.")
        return None
    except Exception as exc:
        print(f"Error reading {browser} cookies: {exc}")
        return None

    auth_token = next((c.value for c in jar if c.name == "auth_token"), None)
    ct0 = next((c.value for c in jar if c.name == "ct0"), None)

    if not auth_token or not ct0:
        print(f"No active X/Twitter session found in {browser}.")
        print("Log into https://x.com first, then re-run this script.")
        return None

    return {"auth_token": auth_token, "ct0": ct0}


async def _refresh_async(cookies: dict[str, str], db_path: str) -> bool:
    try:
        from twscrape import API
    except ImportError:
        print("twscrape not installed. Run: pip install 'signal-harvester[twitter]'")
        return False

    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    api = API(db_path)
    cookie_str = f"auth_token={cookies['auth_token']}; ct0={cookies['ct0']}"

    existing = await api.pool.get_all()
    if existing:
        # INSERT OR REPLACE — updates cookies for the existing username in place
        username = existing[0].username
        await api.pool.add_account(username, "unused", "unused@local", "unused", cookies=cookie_str)
        print(f"Refreshed cookies for @{username}")
    else:
        await api.pool.add_account("harvester", "unused", "unused@local", "unused", cookies=cookie_str)
        print("Added account to twscrape pool.")

    print("Verifying...")
    try:
        async for tweet in api.search("news", limit=1):
            author = tweet.user.displayname if tweet.user else "unknown"
            print(f"✓ Auth verified — found tweet by @{author}")
            return True
    except Exception as exc:
        print(f"✗ Verification failed: {exc}")
        print("  Cookies may be expired. Log into x.com and retry.")
        return False

    print("✗ No results returned — cookies may be invalid.")
    return False


def parse_cookie_string(raw: str) -> dict[str, str] | None:
    """Parse 'auth_token=xxx; ct0=yyy' (or any order/extras) into a dict."""
    parts = {k.strip(): v.strip() for k, _, v in (p.partition("=") for p in raw.split(";"))}
    auth_token = parts.get("auth_token")
    ct0 = parts.get("ct0")
    if not auth_token or not ct0:
        print("Cookie string must contain both auth_token and ct0.")
        print('Example: --cookies "auth_token=abc123; ct0=def456"')
        return None
    return {"auth_token": auth_token, "ct0": ct0}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Refresh twscrape Twitter cookies from your browser session",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--browser", default=None,
        choices=_SUPPORTED_BROWSERS,
        help="Browser to read cookies from automatically (blocked on Chrome 127+ / Brave Nightly).",
    )
    parser.add_argument(
        "--cookies", default=None,
        metavar="'auth_token=xxx; ct0=yyy'",
        help="Paste combined cookie string.",
    )
    parser.add_argument(
        "--auth-token", default=None,
        metavar="TOKEN",
        help="auth_token value (from DevTools → Application → Cookies → x.com).",
    )
    parser.add_argument(
        "--ct0", default=None,
        metavar="VALUE",
        help="ct0 value (from DevTools → Application → Cookies → x.com).",
    )
    parser.add_argument(
        "--db", default=_DEFAULT_DB,
        metavar="PATH",
        help=f"Path to twscrape accounts DB (default: {_DEFAULT_DB})",
    )
    args = parser.parse_args()

    if args.auth_token and args.ct0:
        cookies = {"auth_token": args.auth_token.strip(), "ct0": args.ct0.strip()}
    elif args.cookies:
        cookies = parse_cookie_string(args.cookies)
    elif args.browser:
        print(f"Reading X/Twitter cookies from {args.browser}...")
        cookies = extract_cookies(args.browser)
    else:
        parser.print_help()
        print("\nFor Brave Nightly / Chrome 127+ (auth_token is HttpOnly — DevTools only):")
        print("  F12 → Application → Cookies → https://x.com → copy auth_token and ct0 values, then:")
        print('  python scripts/refresh_twitter.py --auth-token TOKEN --ct0 CT0VALUE')
        sys.exit(1)

    if cookies is None:
        sys.exit(1)

    preview = lambda v: v[:8] + "..."  # noqa: E731
    print(f"Found auth_token ({preview(cookies['auth_token'])}) and ct0 ({preview(cookies['ct0'])})")

    ok = asyncio.run(_refresh_async(cookies, args.db))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
