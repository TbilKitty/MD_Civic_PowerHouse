#!/usr/bin/env python3
"""Download Maryland legislation, detect changes, classify topics, and build site data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
SITE_DATA = ROOT / "site" / "data"
CONFIG_PATH = ROOT / "config.json"
CURRENT_PATH = SITE_DATA / "bills.json"
CHANGES_PATH = SITE_DATA / "changes.json"
BATCH_PATH = SITE_DATA / "notification_batch.json"
META_PATH = SITE_DATA / "meta.json"
TOPICS_PATH = SITE_DATA / "topics.json"
AI_PATH = SITE_DATA / "ai_summaries.json"
SESSIONS_PATH = SITE_DATA / "sessions.json"

TRACKED_FIELDS = (
    "title",
    "synopsis",
    "status",
    "bill_version",
    "chapter_number",
    "crossfile_bill_number",
    "sponsor",
    "committees",
    "hearings",
    "report_actions",
    "passed_by_mga",
    "topics",
)

FIELD_LABELS = {
    "title": "Official title",
    "synopsis": "Official synopsis",
    "status": "Status",
    "bill_version": "Bill version",
    "chapter_number": "Chapter number",
    "crossfile_bill_number": "Cross-file",
    "sponsor": "Primary sponsor",
    "committees": "Committee assignment",
    "hearings": "Hearing schedule",
    "report_actions": "Committee action",
    "passed_by_mga": "Final passage",
    "topics": "Topic classification",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False, sort_keys=False)
        handle.write("\n")
    temporary.replace(path)


def fetch_json(url: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "MarylandLegislativeWatch/1.0 (+public-interest tracker)"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def session_year(session: str) -> int:
    match = re.match(r"^(\d{4})rs$", session.lower())
    if not match:
        raise ValueError(f"Unsupported regular-session identifier: {session}")
    return int(match.group(1))


def candidate_regular_session(config: dict[str, Any], now: datetime | None = None) -> str:
    """Return the newest regular session the updater is allowed to probe."""
    configured = config.get("session", "2026rs").lower()
    if not config.get("automatic_session_rollover", True):
        return configured
    current_year = (now or datetime.now(timezone.utc)).year
    return f"{max(current_year, session_year(configured))}rs"


def fetch_active_session(
    config: dict[str, Any], current_meta: dict[str, Any]
) -> tuple[str, str, list[Any]]:
    """Use a new year's feed when it exists, otherwise preserve the active feed."""
    configured = config.get("session", "2026rs").lower()
    active = str(current_meta.get("session", "")).lower()
    candidates: list[str] = []
    for value in (candidate_regular_session(config), active, configured):
        if value and value not in candidates:
            candidates.append(value)
    last_error: Exception | None = None
    for session in candidates:
        url = f"https://mgaleg.maryland.gov/{session}/misc/billsmasterlist/legislation.json"
        try:
            raw = fetch_json(url)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            continue
        if isinstance(raw, list) and raw:
            return session, url, raw
    if last_error:
        raise last_error
    raise RuntimeError("No available Maryland regular-session feed returned legislation")


def clean(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()
    return value


def unique_strings(values: list[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean(value or "")
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def classify_topics(source: dict[str, Any], topic_config: list[dict[str, Any]]) -> list[str]:
    subject_names = [item.get("Name", "") for item in source.get("BroadSubjects", [])]
    subject_names += [item.get("Name", "") for item in source.get("NarrowSubjects", [])]
    searchable = " ".join(
        [source.get("Title", ""), source.get("Synopsis", ""), *subject_names]
    ).lower()
    matches = []
    for topic in topic_config:
        if any(term.lower() in searchable for term in topic.get("terms", [])):
            matches.append(topic["id"])
    return matches or ["other"]


def source_hash(bill: dict[str, Any]) -> str:
    material = json.dumps(
        {
            "title": bill["title"],
            "synopsis": bill["synopsis"],
            "bill_version": bill["bill_version"],
            "status": bill["status"],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def normalize_bill(source: dict[str, Any], session: str, topics: list[dict[str, Any]]) -> dict[str, Any]:
    bill_number = clean(source.get("BillNumber", ""))
    session_upper = session.upper()
    broad_subjects = unique_strings([x.get("Name") for x in source.get("BroadSubjects", [])])
    narrow_subjects = unique_strings([x.get("Name") for x in source.get("NarrowSubjects", [])])

    committees = unique_strings(
        [
            source.get("CommitteePrimaryOrigin"),
            source.get("CommitteeSecondaryOrigin"),
            source.get("CommitteePrimaryOpposite"),
            source.get("CommitteeSecondaryOpposite"),
        ]
    )
    hearings = unique_strings(
        [
            source.get("HearingDateTimePrimaryHouseOfOrigin"),
            source.get("HearingDateTimeSecondaryHouseOfOrigin"),
            source.get("HearingDateTimePrimaryOppositeHouse"),
            source.get("HearingDateTimeSecondaryOppositeHouse"),
        ]
    )
    reports = unique_strings(
        [source.get("ReportActionHouseOfOrigin"), source.get("ReportActionOppositeHouse")]
    )
    normalized = {
        "id": f"{session_upper}:{bill_number}",
        "session": session_upper,
        "bill_number": bill_number,
        "title": clean(source.get("Title", "")),
        "synopsis": clean(source.get("Synopsis", "")),
        "status": clean(source.get("Status", "")),
        "bill_version": clean(source.get("BillVersion", "")),
        "chapter_number": clean(source.get("ChapterNumber", "")),
        "crossfile_bill_number": clean(source.get("CrossfileBillNumber", "")),
        "sponsor": clean(source.get("SponsorPrimary", "")),
        "sponsors": unique_strings([x.get("Name") for x in source.get("Sponsors", [])]),
        "committees": committees,
        "hearings": hearings,
        "report_actions": reports,
        "passed_by_mga": bool(source.get("PassedByMGA", False)),
        "emergency_bill": bool(source.get("EmergencyBill", False)),
        "constitutional_amendment": bool(source.get("ConstitutionalAmendment", False)),
        "broad_subjects": broad_subjects,
        "narrow_subjects": narrow_subjects,
        "topics": classify_topics(source, topics),
        "official_updated_at": source.get("StatusCurrentAsOf"),
        "details_url": (
            "https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/"
            f"{bill_number}?ys={session_upper}"
        ),
    }
    normalized["source_hash"] = source_hash(normalized)
    return normalized


def value_preview(value: Any, limit: int = 360) -> Any:
    if not isinstance(value, str) or len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def detect_changes(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    observed_at: str,
    announce_all_new: bool = False,
) -> list[dict[str, Any]]:
    if not previous and not announce_all_new:
        return []
    old_by_id = {bill["id"]: bill for bill in previous}
    events: list[dict[str, Any]] = []

    for bill in current:
        old = old_by_id.get(bill["id"])
        if old is None:
            events.append(
                {
                    "event_id": hashlib.sha256(
                        f"{bill['id']}|new|{observed_at}".encode()
                    ).hexdigest()[:24],
                    "bill_id": bill["id"],
                    "bill_number": bill["bill_number"],
                    "title": bill["title"],
                    "change_type": "new_bill",
                    "field": "bill",
                    "field_label": "New bill",
                    "old_value": None,
                    "new_value": bill["title"],
                    "topics": bill["topics"],
                    "status": bill["status"],
                    "details_url": bill["details_url"],
                    "observed_at": observed_at,
                }
            )
            continue

        for field in TRACKED_FIELDS:
            if old.get(field) == bill.get(field):
                continue
            fingerprint = json.dumps(
                [bill["id"], field, old.get(field), bill.get(field)],
                sort_keys=True,
                ensure_ascii=False,
            )
            events.append(
                {
                    "event_id": hashlib.sha256(fingerprint.encode()).hexdigest()[:24],
                    "bill_id": bill["id"],
                    "bill_number": bill["bill_number"],
                    "title": bill["title"],
                    "change_type": "hearing" if field == "hearings" else "change",
                    "field": field,
                    "field_label": FIELD_LABELS[field],
                    "old_value": value_preview(old.get(field)),
                    "new_value": value_preview(bill.get(field)),
                    "topics": bill["topics"],
                    "status": bill["status"],
                    "details_url": bill["details_url"],
                    "observed_at": observed_at,
                }
            )
    return events


SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "plain_language_summary": {"type": "string"},
        "affected_groups": {"type": "array", "items": {"type": "string"}},
        "uncertainties": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "plain_language_summary", "affected_groups", "uncertainties"],
    "additionalProperties": False,
}


def openai_summary(bill: dict[str, Any], api_key: str, model: str) -> dict[str, Any]:
    prompt = f"""Summarize this Maryland bill using only the supplied official metadata.
Do not predict effects not supported by the text. Identify uncertainty explicitly.

Bill: {bill['bill_number']}
Official title: {bill['title']}
Official synopsis: {bill['synopsis']}
Status: {bill['status']}
Subjects: {', '.join(bill['broad_subjects'] + bill['narrow_subjects'])}
"""
    payload = {
        "model": model,
        "store": False,
        "input": prompt,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "maryland_bill_summary",
                "strict": True,
                "schema": SUMMARY_SCHEMA,
            }
        },
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
    for output in result.get("output", []):
        for content in output.get("content", []):
            if content.get("type") == "output_text":
                return json.loads(content["text"])
    raise ValueError("OpenAI response contained no output_text")


def update_ai_summaries(
    bills: list[dict[str, Any]], config: dict[str, Any], force: bool = False,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = existing if existing is not None else read_json(AI_PATH, {})
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return existing

    model = os.getenv("OPENAI_MODEL", config.get("ai_model", "gpt-5-mini"))
    maximum = int(os.getenv("AI_MAX_PER_RUN", config.get("ai_max_per_run", 10)))
    allowed = {
        item.strip() for item in os.getenv("AI_TOPIC_ALLOWLIST", "").split(",") if item.strip()
    }
    generated = 0

    for bill in bills:
        if generated >= maximum:
            break
        if allowed and not allowed.intersection(bill["topics"]):
            continue
        old = existing.get(bill["id"], {})
        if not force and old.get("source_hash") == bill["source_hash"]:
            continue
        try:
            summary = openai_summary(bill, api_key, model)
        except (urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
            print(f"AI summary skipped for {bill['bill_number']}: {exc}", file=sys.stderr)
            continue
        existing[bill["id"]] = {
            **summary,
            "source_hash": bill["source_hash"],
            "generated_at": utc_now(),
            "model": model,
            "human_reviewed": False,
        }
        generated += 1
    return existing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="Read MGA-shaped JSON from a local fixture")
    parser.add_argument("--session", help="Override automatic session selection")
    parser.add_argument("--force-ai", action="store_true")
    args = parser.parse_args()

    config = read_json(CONFIG_PATH, {})
    observed_at = utc_now()
    current_meta = read_json(META_PATH, {})

    if args.source:
        session = (args.session or config.get("session", "2026rs")).lower()
        url = f"local:{args.source}"
        raw = read_json(Path(args.source), [])
    elif args.session:
        session = args.session.lower()
        url = f"https://mgaleg.maryland.gov/{session}/misc/billsmasterlist/legislation.json"
        raw = fetch_json(url)
    else:
        session, url, raw = fetch_active_session(config, current_meta)
    if not isinstance(raw, list):
        raise TypeError("The MGA feed did not return a list")

    previous = read_json(CURRENT_PATH, [])
    history = read_json(CHANGES_PATH, [])
    summaries_before = read_json(AI_PATH, {})
    prior_session = str(current_meta.get("session", "")).upper()
    is_rollover = bool(previous and prior_session and prior_session != session.upper())

    if is_rollover:
        archive_dir = SITE_DATA / "sessions" / prior_session
        write_json(archive_dir / "bills.json", previous)
        write_json(archive_dir / "changes.json", history)
        write_json(archive_dir / "ai_summaries.json", summaries_before)
        write_json(archive_dir / "meta.json", current_meta)
        previous = []
        history = []
        summaries_before = {}

    bills = [normalize_bill(item, session, config["topics"]) for item in raw]
    bills.sort(key=lambda item: item["bill_number"])
    new_events = detect_changes(
        previous, bills, observed_at, announce_all_new=is_rollover
    )

    known_event_ids = {event.get("event_id") for event in history}
    unique_events = [event for event in new_events if event["event_id"] not in known_event_ids]
    history = (unique_events + history)[: int(config.get("max_change_history", 5000))]

    summaries = update_ai_summaries(
        bills, config, force=args.force_ai, existing=summaries_before
    )
    for bill in bills:
        generated = summaries.get(bill["id"])
        bill["ai_summary"] = generated or None

    public_topics = [
        {key: topic[key] for key in ("id", "label", "description")} for topic in config["topics"]
    ]
    public_topics.append(
        {"id": "other", "label": "Other Legislation", "description": "Bills not yet matched to a public-interest category."}
    )

    write_json(CURRENT_PATH, bills)
    write_json(CHANGES_PATH, history)
    write_json(BATCH_PATH, unique_events)
    write_json(AI_PATH, summaries)
    write_json(TOPICS_PATH, public_topics)

    session_label = clean(raw[0].get("YearAndSession", "")) if raw else ""
    if not session_label:
        session_label = (
            config.get("session_label", "")
            if session == config.get("session", "").lower()
            else f"{session_year(session)} Regular Session"
        )
    new_meta = {
        "site_name": config["site_name"],
        "session": session.upper(),
        "session_label": session_label,
        "updated_at": observed_at,
        "official_source": url,
        "bill_count": len(bills),
        "changes_this_run": len(unique_events),
        "ai_enabled": bool(os.getenv("OPENAI_API_KEY")),
        "automatic_session_rollover": bool(
            config.get("automatic_session_rollover", True)
        ),
        "rolled_over_from": prior_session if is_rollover else None,
    }
    write_json(META_PATH, new_meta)

    sessions = read_json(SESSIONS_PATH, [])
    if is_rollover and prior_session:
        archived_entry = {
            "session": prior_session,
            "session_label": current_meta.get("session_label", prior_session),
            "current": False,
            "bills_path": f"data/sessions/{prior_session}/bills.json",
            "changes_path": f"data/sessions/{prior_session}/changes.json",
        }
        sessions = [
            item for item in sessions if item.get("session") != prior_session
        ]
        sessions.append(archived_entry)
    current_entry = {
        "session": session.upper(),
        "session_label": session_label,
        "current": True,
        "bills_path": "data/bills.json",
        "changes_path": "data/changes.json",
    }
    sessions = [item for item in sessions if item.get("session") != session.upper()]
    sessions.append(current_entry)
    sessions.sort(key=lambda item: item["session"], reverse=True)
    write_json(SESSIONS_PATH, sessions)

    rollover_note = f"; rolled over from {prior_session}" if is_rollover else ""
    print(
        f"Updated {len(bills)} bills; detected {len(unique_events)} changes"
        f"{rollover_note}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
