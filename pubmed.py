"""
PubMed integration — searches for recent papers via NCBI Entrez API.
No API key required for up to 3 req/sec; set NCBI_EMAIL for best practice.
"""
import asyncio
import logging
import os
import xml.etree.ElementTree as ET

import httpx

log = logging.getLogger(__name__)

NCBI_EMAIL   = os.getenv("NCBI_EMAIL", "dryoung1029@gmail.com")
NCBI_API_KEY = os.getenv("NCBI_API_KEY", "")  # 10 req/sec with key vs 3 without
ENTREZ_BASE  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


async def fetch_recent_papers(term: str, since: str, max_results: int = 20) -> list[dict]:
    """Search PubMed for `term` published since `since` (YYYY/MM/DD).

    Includes retry logic for NCBI's 3 req/sec rate limit (HTTP 429).
    """
    async with httpx.AsyncClient(timeout=30) as client:
        # Step 1: search
        base_params = {"email": NCBI_EMAIL, **({"api_key": NCBI_API_KEY} if NCBI_API_KEY else {})}
        ids = await _get_with_retry(client, f"{ENTREZ_BASE}/esearch.fcgi", params={
            **base_params,
            "db": "pubmed",
            "term": f"{term}[Title/Abstract]",
            "mindate": since,
            "datetype": "pdat",
            "retmax": max_results,
            "retmode": "json",
        })
        id_list = ids.json().get("esearchresult", {}).get("idlist", [])
        if not id_list:
            return []

        # Brief pause between the two requests for this term
        await asyncio.sleep(0.4)

        # Step 2: fetch details
        fetch_resp = await _get_with_retry(client, f"{ENTREZ_BASE}/efetch.fcgi", params={
            **base_params,
            "db": "pubmed",
            "id": ",".join(id_list),
            "retmode": "xml",
        })

    return _parse_pubmed_xml(fetch_resp.text)


async def _get_with_retry(client: httpx.AsyncClient, url: str, params: dict, retries: int = 4) -> httpx.Response:
    """GET with exponential backoff on 429."""
    delay = 1.0
    for attempt in range(retries):
        resp = await client.get(url, params=params)
        if resp.status_code != 429:
            resp.raise_for_status()
            return resp
        wait = delay * (2 ** attempt)
        log.warning("NCBI 429 on attempt %d — retrying in %.1fs", attempt + 1, wait)
        await asyncio.sleep(wait)
    resp.raise_for_status()  # raise on final attempt
    return resp


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
