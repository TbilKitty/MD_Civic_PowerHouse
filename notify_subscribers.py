#!/usr/bin/env python3
"""Send the current notification batch to the private subscription Worker."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BATCH_PATH = ROOT / "site" / "data" / "notification_batch.json"


def main() -> int:
    endpoint = os.getenv("SUBSCRIPTION_API_URL", "").rstrip("/")
    token = os.getenv("DISPATCH_TOKEN", "")
    if not endpoint or not token:
        print("Subscriber dispatch disabled: missing endpoint or token.")
        return 0
    with BATCH_PATH.open("r", encoding="utf-8") as handle:
        events = json.load(handle)
    if not events:
        print("No new events to dispatch.")
        return 0
    payload = json.dumps({"events": events}).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint}/dispatch",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        result = response.read().decode("utf-8")
    print(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Notification dispatch failed: {exc}", file=sys.stderr)
        raise

