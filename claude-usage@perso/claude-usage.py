#!/usr/bin/env python3
"""Collect Claude usage and print a JSON summary on stdout.

Local data: ~/.claude/projects/**/*.jsonl (Claude Code logs, token usage).
Optional (--limits): subscription limits through the undocumented endpoint
used by Claude Code's /usage, authenticated with the local OAuth token.
The token is only sent to api.anthropic.com.
"""
import json, os, sys, time, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
LIMITS_CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "claude-usage-gnome" / "limits.json"
MIN_FETCH_INTERVAL = 120     # seconds between two API calls, whatever the refresh rate
MIN_BACKOFF, MAX_BACKOFF = 300, 1800  # after a 429: 5 min, doubling up to 30 min


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def local_usage():
    now = datetime.now(timezone.utc)
    day_start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    win5h = now - timedelta(hours=5)
    oldest = min(day_start, win5h)
    cutoff_mtime = oldest.timestamp()

    seen = set()
    today = defaultdict(int)
    last5h = defaultdict(int)
    models = defaultdict(int)
    msgs_today = 0

    for f in (CLAUDE_DIR / "projects").rglob("*.jsonl"):
        try:
            if f.stat().st_mtime < cutoff_mtime:
                continue
            fh = f.open(encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                    msg = d["message"]
                    u = msg["usage"]
                    ts = parse_ts(d["timestamp"])
                except (ValueError, KeyError, TypeError):
                    continue
                if ts < oldest:
                    continue
                key = (msg.get("id"), d.get("requestId"))
                if key in seen:
                    continue
                seen.add(key)
                counts = {
                    "input": u.get("input_tokens") or 0,
                    "output": u.get("output_tokens") or 0,
                    "cache_write": u.get("cache_creation_input_tokens") or 0,
                    "cache_read": u.get("cache_read_input_tokens") or 0,
                }
                if ts >= day_start:
                    msgs_today += 1
                    for k, v in counts.items():
                        today[k] += v
                    models[msg.get("model", "?")] += counts["input"] + counts["output"] + counts["cache_write"]
                if ts >= win5h:
                    for k, v in counts.items():
                        last5h[k] += v
    return {
        "today": dict(today, messages=msgs_today),
        "last_5h": dict(last5h),
        "models_today": dict(sorted(models.items(), key=lambda kv: -kv[1])),
    }


def _load_cache():
    try:
        return json.loads(LIMITS_CACHE.read_text())
    except (OSError, ValueError):
        return {}


def _save_cache(cache):
    try:
        LIMITS_CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = LIMITS_CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(LIMITS_CACHE)
    except OSError:
        pass


def _fetch_limits(creds):
    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {creds['accessToken']}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-usage-gnome/0.2",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.load(r)
    # Keep only the stable-looking fields the extension needs.
    keep = {"plan": creds.get("subscriptionType")}
    for k in ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"):
        w = data.get(k)
        if w and w.get("utilization") is not None:
            keep[k] = {"percent": w["utilization"], "resets_at": w.get("resets_at")}
    rows = (data.get("seven_day_breakdown") or {}).get("rows") or []
    keep["weekly_breakdown"] = [
        {"name": r.get("display_name"), "percent_of_limit": r.get("percent_of_limit")} for r in rows
    ]
    return keep


def subscription_limits():
    """Return limits, hitting the API at most every MIN_FETCH_INTERVAL seconds.

    The last good answer is cached on disk. When a fetch is skipped or fails,
    that cached answer is returned with "stale_reason" (and "retry_at" when
    rate limited) so the extension can keep showing it.
    """
    now = time.time()
    cache = _load_cache()
    cached = cache.get("data")

    def stale(reason, retry_at=None):
        if not cached:
            return {"error": reason, "retry_at": retry_at}
        return dict(cached, fetched_at=cache.get("fetched_at"), stale_reason=reason, retry_at=retry_at)

    if cached and now - cache.get("fetched_at", 0) < MIN_FETCH_INTERVAL:
        return dict(cached, fetched_at=cache["fetched_at"])
    if cache.get("retry_at", 0) > now:
        return stale("rate limited", cache["retry_at"])

    creds = json.loads((CLAUDE_DIR / ".credentials.json").read_text())["claudeAiOauth"]
    if creds.get("expiresAt", 0) / 1000 < now:
        return stale("OAuth token expired, run Claude Code to refresh it")

    try:
        data = _fetch_limits(creds)
    except urllib.error.HTTPError as e:
        if e.code != 429:
            return stale(f"HTTP {e.code}")
        strikes = cache.get("strikes", 0) + 1
        try:
            wait = int(e.headers.get("retry-after", ""))
        except ValueError:
            wait = 0
        wait = max(wait, min(MAX_BACKOFF, MIN_BACKOFF * 2 ** (strikes - 1)))
        cache.update(retry_at=now + wait, strikes=strikes)
        _save_cache(cache)
        return stale("rate limited", cache["retry_at"])
    except (urllib.error.URLError, OSError, ValueError) as e:
        return stale(f"network error ({type(e).__name__})")

    _save_cache({"data": data, "fetched_at": now})
    return dict(data, fetched_at=now)


def main():
    out = {"generated_at": datetime.now(timezone.utc).isoformat()}
    try:
        out["local"] = local_usage()
    except Exception as e:
        out["local"] = {"error": str(e)}
    if "--limits" in sys.argv:
        try:
            out["limits"] = subscription_limits()
        except Exception as e:
            out["limits"] = {"error": f"{type(e).__name__}: {e}"}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
