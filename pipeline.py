"""
Main digest pipeline — orchestrates all steps end-to-end.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Callable, Optional

from pubmed import fetch_recent_papers
from s3_handler import list_unprocessed_pdfs, upload_pdf, mark_processed, download_pdf
from pdf_processor import extract_text
from summarizer import summarize_paper
from digest_builder import build_digest_pdf
from github_updater import update_digest_json, get_search_terms

log = logging.getLogger(__name__)

PERIOD_DAYS = {
    "week": 7,
    "month": 30,
    "3months": 90,
    "6months": 180,
}

PERIOD_LABELS = {
    "week": "1 Week",
    "month": "1 Month",
    "3months": "3 Months",
    "6months": "6 Months",
}


async def run_digest_pipeline(period: str = "week", set_step: Optional[Callable] = None) -> dict:
    def step(msg: str):
        log.info(msg)
        if set_step:
            set_step(msg)

    days = PERIOD_DAYS.get(period, 7)
    period_label = PERIOD_LABELS.get(period, "1 Week")
    now = datetime.utcnow()
    label = f"{period_label} ending {now.strftime('%B %d, %Y')}"
    log.info("Starting digest pipeline: %s (%d days)", label, days)

    # ── Step 1: Load search terms ──────────────────────────────────────────
    step("Loading search terms...")
    search_terms = await get_search_terms()
    log.info("Using %d search terms: %s", len(search_terms), search_terms)

    # ── Step 2: Fetch from PubMed ──────────────────────────────────────────
    papers = []
    since = (now - timedelta(days=days)).strftime("%Y/%m/%d")
    for i, term in enumerate(search_terms):
        step(f"Fetching PubMed: '{term}' ({i + 1}/{len(search_terms)})")
        fetched = await fetch_recent_papers(term, since=since)
        papers.extend(fetched)
        log.info("  '%s' → %d papers", term, len(fetched))
        if i < len(search_terms) - 1:
            await asyncio.sleep(0.5)  # stay under NCBI rate limit

    # Deduplicate by PMID
    seen: set = set()
    unique_papers = []
    for p in papers:
        if p["pmid"] not in seen:
            seen.add(p["pmid"])
            unique_papers.append(p)
    log.info("Total unique PubMed papers: %d", len(unique_papers))

    # ── Step 3: Process unprocessed S3 PDFs ───────────────────────────────
    step("Checking S3 for uploaded PDFs...")
    unprocessed = await list_unprocessed_pdfs()
    log.info("Found %d unprocessed PDFs in S3", len(unprocessed))
    for key in unprocessed:
        try:
            pdf_bytes = await download_pdf(key)
            text = extract_text(pdf_bytes)
            summary = await summarize_paper({"title": key, "abstract": text[:4000], "source": "upload"})
            summary["source"] = "upload"
            summary["s3_key"] = key
            unique_papers.append(summary)
            await mark_processed(key)
            log.info("  Processed upload: %s", key)
        except Exception as exc:
            log.warning("  Failed to process %s: %s", key, exc)

    if not unique_papers:
        log.warning("No papers found for period '%s' — skipping digest update", period)
        return {
            "period": period,
            "label": label,
            "total": 0,
            "warning": "No papers were found for this search period. Try a longer period or different search terms.",
        }

    # ── Step 4: Summarize with Claude ─────────────────────────────────────
    summarized = []
    for idx, paper in enumerate(unique_papers):
        step(f"Summarizing with Claude ({idx + 1}/{len(unique_papers)})...")
        if paper.get("source") == "upload" and "clinical_takeaway" in paper:
            summarized.append(paper)
            continue
        try:
            summary = await summarize_paper(paper)
            summarized.append(summary)
        except Exception as exc:
            log.warning("  Summarization failed for %s: %s", paper.get("pmid", "?"), exc)

    if not summarized:
        return {
            "period": period,
            "label": label,
            "total": 0,
            "warning": "Papers were found but all summarizations failed. Check ANTHROPIC_API_KEY.",
        }

    # ── Step 5: Build PDF digest ───────────────────────────────────────────
    step("Building PDF digest...")
    pdf_bytes, pdf_filename = build_digest_pdf(label, summarized)
    s3_pdf_key = f"pdfs/{pdf_filename}"
    await upload_pdf(s3_pdf_key, pdf_bytes)
    log.info("PDF uploaded to s3://%s", s3_pdf_key)

    # ── Step 6: Update digest.json on GitHub ──────────────────────────────
    step("Updating GitHub digest.json...")
    await update_digest_json(label, summarized, s3_pdf_key, period=period)
    log.info("digest.json updated")

    return {
        "period": period,
        "label": label,
        "pubmed_papers": len([p for p in summarized if p.get("source") != "upload"]),
        "uploaded_pdfs": len([p for p in summarized if p.get("source") == "upload"]),
        "total": len(summarized),
        "pdf_key": s3_pdf_key,
    }
