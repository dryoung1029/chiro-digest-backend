"""
Main digest pipeline — orchestrates all steps end-to-end.
"""
import logging
from datetime import datetime, timedelta

from pubmed import fetch_recent_papers
from s3_handler import list_unprocessed_pdfs, upload_pdf, mark_processed, download_pdf
from pdf_processor import extract_text
from summarizer import summarize_paper
from digest_builder import build_digest_pdf
from github_updater import update_digest_json

log = logging.getLogger(__name__)

SEARCH_TERMS = [
    "chiropractic",
    "spinal manipulation",
    "chiropractic adjustment",
    "vertebral subluxation",
]


async def run_digest_pipeline() -> dict:
    week_label = datetime.utcnow().strftime("Week of %B %d, %Y")
    log.info("Starting digest pipeline for: %s", week_label)
    papers = []

    # ── Step 1: Fetch from PubMed ──────────────────────────────────────────
    log.info("Fetching PubMed papers...")
    since = (datetime.utcnow() - timedelta(days=7)).strftime("%Y/%m/%d")
    for term in SEARCH_TERMS:
        fetched = await fetch_recent_papers(term, since=since)
        papers.extend(fetched)
        log.info("  '%s' → %d papers", term, len(fetched))

    # Deduplicate by PMID
    seen = set()
    unique_papers = []
    for p in papers:
        if p["pmid"] not in seen:
            seen.add(p["pmid"])
            unique_papers.append(p)
    log.info("Total unique PubMed papers: %d", len(unique_papers))

    # ── Step 2: Process unprocessed S3 PDFs ───────────────────────────────
    log.info("Checking S3 for unprocessed PDFs...")
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

    # ── Step 3: Summarize PubMed papers with Claude ────────────────────────
    log.info("Summarizing %d PubMed papers with Claude...", len(unique_papers))
    summarized = []
    for paper in unique_papers:
        if paper.get("source") == "upload" and "clinical_takeaway" in paper:
            summarized.append(paper)
            continue
        try:
            summary = await summarize_paper(paper)
            summarized.append(summary)
        except Exception as exc:
            log.warning("  Summarization failed for %s: %s", paper.get("pmid", "?"), exc)

    # ── Step 4: Build PDF digest ───────────────────────────────────────────
    log.info("Building PDF digest...")
    pdf_bytes, pdf_filename = build_digest_pdf(week_label, summarized)
    s3_pdf_key = f"pdfs/{pdf_filename}"
    await upload_pdf(s3_pdf_key, pdf_bytes)
    log.info("PDF uploaded to s3://%s", s3_pdf_key)

    # ── Step 5: Update digest.json on GitHub ──────────────────────────────
    log.info("Updating digest.json on GitHub...")
    await update_digest_json(week_label, summarized, s3_pdf_key)
    log.info("digest.json updated")

    return {
        "week": week_label,
        "pubmed_papers": len([p for p in summarized if p.get("source") != "upload"]),
        "uploaded_pdfs": len([p for p in summarized if p.get("source") == "upload"]),
        "total": len(summarized),
        "pdf_key": s3_pdf_key,
    }
