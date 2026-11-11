"""Sum API-equivalent cost of Claude Code transcripts for today, the five-hour
limit window, the billing week and this month.

Usage: scan.py [--week-start EPOCH_SECONDS] [--five-start EPOCH_SECONDS]

Reads every *.jsonl under <config>/projects modified since the earliest of the
local month start and the given window starts (the seven-day and five-hour
limit windows' starts, not calendar periods), prices each unique assistant
response from its usage block, and prints {"day": usd, "five": usd | null,
"week": usd | null, "month": usd, "unpriced": [model, ...]} as JSON; "five" and
"week" are null without their flag. Local time.

Per-file results are cached in <cache>/claude-usage-band/scan-cache.json:
an unchanged file is not read, and a file that grew is read from where the
last scan stopped (transcripts are append-only).
"""
import json
import os
import sys
import time
from datetime import datetime

# USD per million tokens: input, output, 5m cache write, 1h cache write, cache read.
PRICES = [
    ("claude-fable-5-2", (8.0, 40.0, 10.0, 16.0, 0.2)),
    ("claude-mythos-5-2", (8.0, 40.0, 10.0, 16.0, 0.2)),
    ("claude-fable-5-1", (10.0, 50.0, 12.5, 20.0, 0.25)),
    ("claude-mythos-5-1", (10.0, 50.0, 12.5, 20.0, 0.25)),
    ("claude-fable-5", (10.0, 50.0, 12.5, 20.0, 1.0)),
    ("claude-mythos-5", (10.0, 50.0, 12.5, 20.0, 1.0)),
    ("claude-opus-5-5", (4.0, 20.0, 5.0, 8.0, 0.2)),
    ("claude-opus-5", (5.0, 25.0, 6.25, 10.0, 0.5)),
    ("claude-opus-4-1", (15.0, 75.0, 18.75, 30.0, 1.5)),
    ("claude-opus-4-2025", (15.0, 75.0, 18.75, 30.0, 1.5)),  # Opus 4 (claude-opus-4-YYYYMMDD)
    ("claude-opus-4", (5.0, 25.0, 6.25, 10.0, 0.5)),
    ("claude-sonnet-5-5", (2.0, 10.0, 2.5, 4.0, 0.1)),
    ("claude-sonnet-5", (2.0, 10.0, 2.5, 4.0, 0.2)),
    ("claude-sonnet-4", (3.0, 15.0, 3.75, 6.0, 0.3)),
    ("claude-haiku-5-5", (0.1, 0.5, 0.125, 0.2, 0.01)),
    ("claude-haiku-4", (1.0, 5.0, 1.25, 2.0, 0.1)),
]
HAIKU_55_TIER = 100_000  # prompts above this bill at 5x on Haiku 5.5
WEB_SEARCH_USD = 0.01


def rates(model):
    for prefix, r in PRICES:
        if model.startswith(prefix):
            return r
    return None


def cost(model, u):
    r = rates(model)
    if r is None:
        return None
    inp = u.get("input_tokens") or 0
    out = u.get("output_tokens") or 0
    read = u.get("cache_read_input_tokens") or 0
    cc = u.get("cache_creation") or {}
    w5 = cc.get("ephemeral_5m_input_tokens")
    w1 = cc.get("ephemeral_1h_input_tokens") or 0
    if w5 is None:
        w5 = (u.get("cache_creation_input_tokens") or 0) - w1
    scale = 1.0
    if model.startswith("claude-haiku-5-5") and inp + read + w5 + w1 > HAIKU_55_TIER:
        scale = 5.0
    if u.get("speed") == "fast":
        scale *= 2.0
    if u.get("inference_geo") == "us":
        scale *= 1.1
    usd = (inp * r[0] + out * r[1] + w5 * r[2] + w1 * r[3] + read * r[4]) * scale / 1e6
    web = (u.get("server_tool_use") or {}).get("web_search_requests") or 0
    return usd + web * WEB_SEARCH_USD


CACHE_VERSION = 2
TAIL = 64  # bytes before the saved offset, checked to confirm a file only grew


def parse(fh, rec, since):
    """Read complete lines from rec["offset"] on, folding them into rec."""
    fh.seek(rec["offset"])
    pos = rec["offset"]
    best = rec["best"]
    for line in fh:
        if not line.endswith(b"\n"):
            break  # a line still being written: pick it up next time
        pos += len(line)
        if b'"usage"' not in line or b'"assistant"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("type") != "assistant":
            continue
        m = o.get("message") or {}
        u = m.get("usage")
        ts = o.get("timestamp")
        if not u or not ts:
            continue
        mid, req = m.get("id"), o.get("requestId")
        key = None if mid is None and req is None else f"{mid}\t{req}"
        out = u.get("output_tokens") or 0
        if key is not None and key in best and best[key][0] >= out:
            continue
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if t < since:
            continue
        model = m.get("model") or ""
        if model.startswith("<"):
            continue
        c = cost(model, u)
        if c is None:
            if model not in rec["unpriced"]:
                rec["unpriced"].append(model)
            continue
        if key is None:
            rec["loose"].append([t, c])
        else:
            best[key] = [out, t, c]
    rec["offset"] = pos
    fh.seek(max(0, pos - TAIL))
    rec["tail"] = fh.read(pos - max(0, pos - TAIL)).hex()


def grew_only(fh, rec, size):
    if size < rec["offset"]:
        return False
    start = max(0, rec["offset"] - TAIL)
    fh.seek(start)
    return fh.read(rec["offset"] - start).hex() == rec["tail"]


def load_cache(path, header, since):
    """The cached files, if priced the same way and covering since onward."""
    try:
        with open(path) as f:
            data = json.load(f)
        if data.get("header") == header and data["since"] <= since:
            return data["since"], data["files"]
    except (OSError, ValueError, KeyError):
        pass
    return since, {}


def save_cache(path, header, since, files):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump({"header": header, "since": since, "files": files}, f, separators=(",", ":"))
    os.replace(tmp, path)


def window_args(argv):
    """{"--week-start": seconds, "--five-start": seconds}, each when given."""
    out = {}
    for flag, value in zip(argv[1::2], argv[2::2]):
        if flag in ("--week-start", "--five-start"):
            try:
                out[flag] = float(value)
            except ValueError:
                pass
    return out


def main():
    args = window_args(sys.argv)
    week_start = args.get("--week-start")
    five_start = args.get("--five-start")
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    root = os.path.join(base, "projects")
    cache_dir = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    cache_path = os.path.join(cache_dir, "claude-usage-band", "scan-cache.json")
    now = time.localtime()
    today = time.strftime("%Y-%m-%d", now)
    month = today[:7]
    month_start = time.mktime((now.tm_year, now.tm_mon, 1, 0, 0, 0, 0, 0, -1))
    day_start = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, -1))
    since = min([month_start] + [w for w in (week_start, five_start) if w is not None])

    # Anything that changes how an entry was priced drops the cache, and a
    # new month starts it over; a cache that starts after since is rebuilt.
    header = [CACHE_VERSION, month, root, PRICES]
    header = json.loads(json.dumps(header))
    since, old = load_cache(cache_path, header, since)
    files = {}
    dirty = False

    for dirpath, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_mtime < since:
                continue
            rec = old.get(path)
            if rec and rec["size"] == st.st_size and rec["mtime"] == st.st_mtime:
                files[path] = rec
                continue
            dirty = True
            try:
                with open(path, "rb") as fh:
                    if not (rec and grew_only(fh, rec, st.st_size)):
                        rec = {"offset": 0, "best": {}, "loose": [], "unpriced": [], "tail": ""}
                    parse(fh, rec, since)
            except OSError:
                continue
            rec["size"], rec["mtime"] = st.st_size, st.st_mtime
            files[path] = rec

    if dirty or files.keys() != old.keys():
        save_cache(cache_path, header, since, files)

    # A response can be logged several times as it streams (subagent
    # transcripts write a partial entry first) or copied into a resumed or
    # forked session; keep the one with the most output tokens per key.
    best = {}
    entries = []
    unpriced = set()
    for rec in files.values():
        unpriced.update(rec["unpriced"])
        entries.extend(rec["loose"])
        for key, (out, t, c) in rec["best"].items():
            if key not in best or best[key][0] < out:
                best[key] = (out, t, c)
    entries.extend((t, c) for _, t, c in best.values())

    day_usd = five_usd = week_usd = month_usd = 0.0
    for t, c in entries:
        if t >= month_start:
            month_usd += c
        if t >= day_start:
            day_usd += c
        if week_start is not None and t >= week_start:
            week_usd += c
        if five_start is not None and t >= five_start:
            five_usd += c

    out = {
        "day": round(day_usd, 4),
        "five": None if five_start is None else round(five_usd, 4),
        "week": None if week_start is None else round(week_usd, 4),
        "month": round(month_usd, 4),
        "unpriced": sorted(unpriced),
    }
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
