"""
Updates digest.json in the chiro-digest GitHub repo via the GitHub Contents API.
Requires: GITHUB_TOKEN env var with `contents:write` permission.
"""
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
SEARCH_TERMS_FILE = "search_terms.json"
API_BASE = "https://api.github.com"

DEFAULT_SEARCH_TERMS = [
    "chiropractic",
    "spinal manipulation",
    "chiropractic adjustment",
    "vertebral subluxation",
]


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


# ── Search terms ─────────────────────────────────────────────────────────────

async def get_search_terms() -> list[str]:
    """Return custom search terms from GitHub, or defaults if none saved."""
    async with httpx.AsyncClient(timeout=15, headers=_headers()) as client:
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{SEARCH_TERMS_FILE}")
        if resp.status_code == 404:
            return list(DEFAULT_SEARCH_TERMS)
        resp.raise_for_status()
        data = json.loads(base64.b64decode(resp.json()["content"]).decode())
        return data.get("terms", DEFAULT_SEARCH_TERMS)


async def save_search_terms(terms: list[str]) -> None:
    """Write search terms to GitHub (creates or updates search_terms.json)."""
    encoded = base64.b64encode(json.dumps({"terms": terms}, indent=2).encode()).decode()
    async with httpx.AsyncClient(timeout=15, headers=_headers()) as client:
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{SEARCH_TERMS_FILE}")
        payload: dict = {"message": "config: update search terms", "content": encoded}
        if resp.status_code == 200:
            payload["sha"] = resp.json()["sha"]
        upd = await client.put(f"{API_BASE}/repos/{REPO}/contents/{SEARCH_TERMS_FILE}", json=payload)
        upd.raise_for_status()
        log.info("search_terms.json updated (%d terms)", len(terms))


# ── Digest CRUD ───────────────────────────────────────────────────────────────

async def update_digest_json(week_label: str, papers: list[dict], pdf_s3_key: str, period: str = "week", digest_summary: str = "") -> None:
    async with httpx.AsyncClient(timeout=30, headers=_headers()) as client:
        # 1. Get current file (need SHA for update)
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}")
        resp.raise_for_status()
        current = resp.json()
        sha = current["sha"]
        existing = json.loads(base64.b64decode(current["content"]).decode())

        # 2. Build new entry
        entry = {
            "label": week_label,
            "period": period,
            "date": datetime.utcnow().strftime("%Y-%m-%d"),
            "pdf_key": pdf_s3_key,
            "paper_count": len(papers),
            "digest_summary": digest_summary,
            "papers": [
                {
                    "title": p.get("title", ""),
                    "one_line": p.get("one_line", ""),
                    "clinical_takeaway": p.get("clinical_takeaway", ""),
                    "key_finding": p.get("key_finding", ""),
                    "relevance_score": p.get("relevance_score"),
                    "study_design": p.get("study_design", ""),
                    "sample_size": p.get("sample_size"),
                    "source": p.get("source", "pubmed"),
                    "url": p.get("url", ""),
                    "pmid": p.get("pmid", ""),
                    "pmc_id": p.get("pmc_id"),
                    "doi": p.get("doi"),
                }
                for p in papers
            ],
        }

        # 3. Prepend (most recent first)
        existing.setdefault("weeks", [])
        existing["weeks"].insert(0, entry)

        # Update running themes
        themes: dict = existing.get("runningThemes", {}) if isinstance(existing.get("runningThemes"), dict) else {}
        for p in papers:
            for word in (p.get("one_line", "") + " " + p.get("key_finding", "")).lower().split():
                if len(word) > 6:
                    themes[word] = themes.get(word, 0) + 1
        existing["runningThemes"] = dict(sorted(themes.items(), key=lambda x: -x[1])[:50])

        # 4. Push
        new_content = base64.b64encode(json.dumps(existing, indent=2).encode()).decode()
        upd = await client.put(
            f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}",
            json={"message": f"digest: {week_label}", "content": new_content, "sha": sha},
        )
        upd.raise_for_status()
        log.info("digest.json updated successfully")


async def get_digest_json() -> dict:
    """Fetch the current digest.json directly from the GitHub API (bypasses Pages cache)."""
    async with httpx.AsyncClient(timeout=15, headers=_headers()) as client:
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}")
        resp.raise_for_status()
        return json.loads(base64.b64decode(resp.json()["content"]).decode())


async def delete_digest_entry(date: str) -> None:
    """Remove the digest entry matching `date` (YYYY-MM-DD) from digest.json."""
    async with httpx.AsyncClient(timeout=30, headers=_headers()) as client:
        resp = await client.get(f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}")
        resp.raise_for_status()
        sha = resp.json()["sha"]
        existing = json.loads(base64.b64decode(resp.json()["content"]).decode())

        before = len(existing.get("weeks", []))
        existing["weeks"] = [w for w in existing.get("weeks", []) if w.get("date") != date]
        if len(existing["weeks"]) == before:
            raise ValueError(f"No digest entry found for date {date!r}")

        new_content = base64.b64encode(json.dumps(existing, indent=2).encode()).decode()
        upd = await client.put(
            f"{API_BASE}/repos/{REPO}/contents/{FILE_PATH}",
            json={"message": f"digest: delete {date}", "content": new_content, "sha": sha},
        )
        upd.raise_for_status()
        log.info("Deleted digest entry for %s", date)
