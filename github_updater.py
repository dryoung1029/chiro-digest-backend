"""
Updates digest.json in the chiro-digest GitHub repo via the GitHub Contents API.
Requires: GITHUB_TOKEN env var with `contents:write` permission.
"""
import asyncio
import base64
import json
import logging
import os
from datetime import datetime

import httpx

log = logging.getLogger(__name__)

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
REPO = os.getenv("GITHUB_REPO", "dryoung1029/chiro-digest")
FILE_PATH = "digest.json"
API_BASE = "https://api.github.com"


async def update_digest_json(week_label: str, papers: list[dict], pdf_s3_key: str) -> None:
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    async with httpx.AsyncClient(timeout=30, headers=headers) as client:
        # 1. Get current file (need SHA for update)
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}")
        resp.raise_for_status()
        current = resp.json()
        sha = current["sha"]
        existing = json.loads(base64.b64decode(current["content"]).decode())

        # 2. Build new week entry
        week_entry = {
            "label": week_label,
            "date": datetime.utcnow().strftime("%Y-%m-%d"),
            "pdf_key": pdf_s3_key,
            "paper_count": len(papers),
            "papers": [
                {
                    "title": p.get("title", ""),
                    "one_line": p.get("one_line", ""),
                    "clinical_takeaway": p.get("clinical_takeaway", ""),
                    "relevance_score": p.get("relevance_score"),
                    "study_design": p.get("study_design", ""),
                    "source": p.get("source", "pubmed"),
                    "url": p.get("url", ""),
                    "pmid": p.get("pmid", ""),
                }
                for p in papers
            ],
        }

        # 3. Prepend to weeks list (most recent first)
        existing.setdefault("weeks", [])
        existing["weeks"].insert(0, week_entry)

        # Update running themes (just track recurring topics for now)
        themes: dict = existing.get("runningThemes", {}) if isinstance(existing.get("runningThemes"), dict) else {}
        for p in papers:
            for word in (p.get("one_line", "") + " " + p.get("key_finding", "")).lower().split():
                if len(word) > 6:
                    themes[word] = themes.get(word, 0) + 1
        existing["runningThemes"] = dict(sorted(themes.items(), key=lambda x: -x[1])[:50])

        # 4. Push update
        new_content = base64.b64encode(
            json.dumps(existing, indent=2).encode()
        ).decode()

        update_resp = await client.put(
            f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}",
            json={
                "message": f"digest: {week_label}",
                "content": new_content,
                "sha": sha,
            },
        )
        update_resp.raise_for_status()
        log.info("digest.json updated successfully")
