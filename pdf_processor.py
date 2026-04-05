"""
PDF text extraction using pdfplumber.
"""
import io
import logging

import pdfplumber

log = logging.getLogger(__name__)


def extract_text(pdf_bytes: bytes, max_chars: int = 8000) -> str:
    """Extract text from a PDF byte string, up to max_chars."""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages_text = []
            total = 0
            for page in pdf.pages:
                text = page.extract_text() or ""
                pages_text.append(text)
                total += len(text)
                if total >= max_chars:
                    break
            full_text = "\n\n".join(pages_text)
            return full_text[:max_chars]
    except Exception as exc:
        log.warning("PDF text extraction failed: %s", exc)
        return ""
