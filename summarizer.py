"""
Claude API summarization — generates structured summaries of research papers.
"""
import asyncio
import logging
import os

import anthropic

log = logging.getLogger(__name__)

_client = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


SYSTEM_PROMPT = """You are a chiropractic research analyst.
Given a research paper's title and abstract, produce a concise, clinically useful summary.
Respond ONLY with a JSON object (no markdown, no explanation) with these exact keys:
- "title": the paper title (string)
- "one_line": a single sentence (≤20 words) capturing the core finding
- "clinical_takeaway": 2-3 sentences a chiropractor can act on
- "study_design": e.g. RCT, systematic review, cohort, case report, etc.
- "sample_size": integer or null
- "key_finding": 1-2 sentences on the primary result
- "relevance_score": integer 1-5 (5 = highly relevant to chiropractic practice)
"""


async def summarize_paper(paper: dict) -> dict:
    """Summarize a paper using Claude. Returns a dict with summary fields merged into paper."""
    title = paper.get("title", "Untitled")
    abstract = paper.get("abstract", "No abstract available.")

    prompt = f"Title: {title}\n\nAbstract:\n{abstract}"

    client = _get_client()
    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )

    import json
    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    summary = json.loads(raw)

    return {**paper, **summary}
