"""
Builds the weekly PDF digest using ReportLab.
"""
import io
import logging
from datetime import datetime
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable,
    Table, TableStyle, PageBreak,
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT

log = logging.getLogger(__name__)

# Brand colors
DARK_BLUE = colors.HexColor("#1a3a5c")
ACCENT = colors.HexColor("#2e86c1")
LIGHT_GRAY = colors.HexColor("#f4f6f8")
MID_GRAY = colors.HexColor("#7f8c8d")


def build_digest_pdf(week_label: str, papers: list[dict]) -> tuple[bytes, str]:
    """Build and return (pdf_bytes, filename)."""
    buf = io.BytesIO()
    filename = f"chiro-digest-{datetime.utcnow().strftime('%Y-%m-%d')}.pdf"

    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title=f"Chiropractic Research Digest — {week_label}",
    )

    styles = getSampleStyleSheet()
    story = []

    # ── Cover ─────────────────────────────────────────────────────────────
    story.append(Spacer(1, 0.5 * inch))
    story.append(Paragraph(
        "CHIROPRACTIC RESEARCH DIGEST",
        ParagraphStyle("cover_title", fontSize=26, textColor=DARK_BLUE,
                       fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=6),
    ))
    story.append(Paragraph(
        week_label,
        ParagraphStyle("cover_sub", fontSize=13, textColor=ACCENT,
                       fontName="Helvetica", alignment=TA_CENTER, spaceAfter=4),
    ))
    story.append(Paragraph(
        f"{len(papers)} paper{'s' if len(papers) != 1 else ''} reviewed",
        ParagraphStyle("cover_count", fontSize=10, textColor=MID_GRAY,
                       fontName="Helvetica", alignment=TA_CENTER),
    ))
    story.append(Spacer(1, 0.3 * inch))
    story.append(HRFlowable(width="100%", thickness=2, color=ACCENT))
    story.append(Spacer(1, 0.4 * inch))

    # Sort by relevance score descending
    sorted_papers = sorted(papers, key=lambda p: p.get("relevance_score", 0), reverse=True)

    for i, paper in enumerate(sorted_papers, 1):
        title = paper.get("title", "Untitled")
        one_line = paper.get("one_line", "")
        clinical = paper.get("clinical_takeaway", "")
        design = paper.get("study_design", "")
        sample = paper.get("sample_size")
        key_finding = paper.get("key_finding", "")
        relevance = paper.get("relevance_score", "")
        authors = paper.get("authors", [])
        journal = paper.get("journal", "")
        pub_date = paper.get("pub_date", "")
        url = paper.get("url", "")
        source = paper.get("source", "pubmed")

        # Paper number + title
        story.append(Paragraph(
            f"{i}. {title}",
            ParagraphStyle("paper_title", fontSize=12, textColor=DARK_BLUE,
                           fontName="Helvetica-Bold", spaceAfter=4, leading=16),
        ))

        # Meta row
        meta_parts = []
        if authors:
            meta_parts.append(", ".join(authors[:3]) + (" et al." if len(authors) > 3 else ""))
        if journal:
            meta_parts.append(journal)
        if pub_date:
            meta_parts.append(pub_date)
        if source == "upload":
            meta_parts.append("📎 Uploaded PDF")
        if meta_parts:
            story.append(Paragraph(
                " · ".join(meta_parts),
                ParagraphStyle("meta", fontSize=8, textColor=MID_GRAY,
                               fontName="Helvetica-Oblique", spaceAfter=6),
            ))

        # One-liner
        if one_line:
            story.append(Paragraph(
                f"<b>In brief:</b> {one_line}",
                ParagraphStyle("one_line", fontSize=10, textColor=colors.black,
                               fontName="Helvetica", spaceAfter=5, leftIndent=8),
            ))

        # Key finding
        if key_finding:
            story.append(Paragraph(
                f"<b>Key finding:</b> {key_finding}",
                ParagraphStyle("finding", fontSize=10, textColor=colors.black,
                               fontName="Helvetica", spaceAfter=5, leftIndent=8),
            ))

        # Clinical takeaway box
        if clinical:
            box_data = [[Paragraph(
                f"<b>Clinical takeaway:</b> {clinical}",
                ParagraphStyle("takeaway", fontSize=10, textColor=DARK_BLUE,
                               fontName="Helvetica", leading=14),
            )]]
            box = Table(box_data, colWidths=["100%"])
            box.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("ROUNDEDCORNERS", [4]),
            ]))
            story.append(box)
            story.append(Spacer(1, 4))

        # Tags row
        tags = []
        if design:
            tags.append(f"Design: {design}")
        if sample is not None:
            tags.append(f"n={sample}")
        if relevance:
            tags.append(f"Relevance: {'★' * int(relevance)}{'☆' * (5 - int(relevance))}")
        if url and source == "pubmed":
            tags.append(f"PubMed: {url}")
        if tags:
            story.append(Paragraph(
                "   |   ".join(tags),
                ParagraphStyle("tags", fontSize=8, textColor=MID_GRAY,
                               fontName="Helvetica", spaceAfter=8),
            ))

        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.lightgrey))
        story.append(Spacer(1, 0.2 * inch))

        # Page break every 3 papers to avoid huge pages
        if i % 3 == 0 and i < len(sorted_papers):
            story.append(PageBreak())

    # ── Footer note ───────────────────────────────────────────────────────
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph(
        f"Generated automatically • {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC • "
        "dryoung1029.github.io/chiro-digest",
        ParagraphStyle("footer", fontSize=8, textColor=MID_GRAY,
                       fontName="Helvetica-Oblique", alignment=TA_CENTER),
    ))

    doc.build(story)
    return buf.getvalue(), filename
