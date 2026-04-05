"""
PubMed integration — searches for recent papers via NCBI Entrez API.
No API key required for up to 3 req/sec; set NCBI_EMAIL for best practice.
"""
import asyncio
import logging
import os
import xml.etree.ElementTree as ET
from typing import Optional

import httpx

log = logging.getLogger(__name__)

NCBI_EMAIL = os.getenv("NCBI_EMAIL", "dryoung1029@gmail.com")
ENTREZ_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


async def fetch_recent_papers(term: str, since: str, max_results: int = 20) -> list[dict]:
    """Search PubMed for `term` published since `since` (YYYY/MM/DD)."""
    async with httpx.AsyncClient(timeout=30) as client:
        # Step 1: search
        search_resp = await client.get(
            f"{ENTREZ_BASE}/esearch.fcgi",
            params={
                "db": "pubmed",
                "term": f"{term}[Title/Abstract]",
                "mindate": since,
                "datetype": "pdat",
                "retmax": max_results,
                "retmode": "json",
                "email": NCBI_EMAIL,
            },
        )
        search_resp.raise_for_status()
        ids = search_resp.json().get("esearchresult", {}).get("idlist", [])
        if not ids:
            return []

        # Step 2: fetch details
        fetch_resp = await client.get(
            f"{ENTREZ_BASE}/efetch.fcgi",
            params={
                "db": "pubmed",
                "id": ",".join(ids),
                "retmode": "xml",
                "email": NCBI_EMAIL,
            },
        )
        fetch_resp.raise_for_status()

    return _parse_pubmed_xml(fetch_resp.text)


def _parse_pubmed_xml(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    papers = []
    for article in root.findall(".//PubmedArticle"):
        try:
            pmid = article.findtext(".//PMID", "")
            title = article.findtext(".//ArticleTitle", "No title")
            abstract = " ".join(
                t.text or "" for t in article.findall(".//AbstractText")
            ).strip() or "No abstract available."
            authors = []
            for author in article.findall(".//Author")[:5]:
                last = author.findtext("LastName", "")
                fore = author.findtext("ForeName", "")
                if last:
                    authors.append(f"{last} {fore}".strip())
            journal = article.findtext(".//Journal/Title", "Unknown Journal")
            pub_date = (
                article.findtext(".//PubDate/Year")
                or article.findtext(".//PubDate/MedlineDate", "")[:4]
            )
            papers.append({
                "pmid": pmid,
                "title": title,
                "abstract": abstract,
                "authors": authors,
                "journal": journal,
                "pub_date": pub_date,
                "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "source": "pubmed",
            })
        except Exception as exc:
            log.warning("Failed to parse article: %s", exc)
    return papers
