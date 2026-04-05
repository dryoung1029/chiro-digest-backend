/**
 * Chiro Digest — frontend
 *
 * Loads digest.json from GitHub Pages, renders paper cards, and lets
 * the user trigger a new pipeline run (with period selection) against
 * the backend API served from the same origin.
 */

const DIGEST_JSON_URL = 'https://dryoung1029.github.io/chiro-digest/digest.json';
const S3_BASE = 'https://chiro-digest-userdata.s3.us-west-2.amazonaws.com';
const PERIOD_LABELS = { week: '1 Week', month: '1 Month', '3months': '3 Months', '6months': '6 Months' };

let selectedPeriod = 'week';
let pollInterval   = null;
let digestData     = null;
let activeIndex    = 0;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupPeriodButtons();
  document.getElementById('generate-btn').addEventListener('click', generateDigest);
  await loadDigest();
  await checkStatus();
});

// ── Period selector ───────────────────────────────────────────────────────
function setupPeriodButtons() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPeriod = btn.dataset.period;
    });
  });
}

// ── Load digest.json from GitHub Pages ───────────────────────────────────
async function loadDigest() {
  try {
    const res = await fetch(`${DIGEST_JSON_URL}?t=${Date.now()}`);
    if (!res.ok) return;
    digestData = await res.json();
    const weeks = digestData.weeks || [];
    if (weeks.length > 0) {
      renderDigest(weeks[0], 0);
      renderHistory(weeks);
    }
  } catch (e) {
    console.warn('Could not load digest.json:', e);
  }
}

// ── Check current pipeline status on load ────────────────────────────────
async function checkStatus() {
  try {
    const res  = await fetch('/status');
    const data = await res.json();
    if (data.status === 'running') {
      startPolling(data.period || 'week');
    } else {
      updateStatusIndicator(data.status, null);
    }
  } catch (e) {
    // backend unavailable — ignore
  }
}

// ── Trigger new digest run ────────────────────────────────────────────────
async function generateDigest() {
  try {
    const res = await fetch(`/run?period=${selectedPeriod}`, { method: 'POST' });
    if (res.status === 409) {
      setRunStatus('A digest is already being generated. Please wait...');
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setRunStatus(`Error: ${err.detail || res.statusText}`);
      return;
    }
    startPolling(selectedPeriod);
  } catch (e) {
    setRunStatus(`Failed to start: ${e.message}`);
  }
}

// ── Poll /status while running ────────────────────────────────────────────
function startPolling(period) {
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('progress-bar').style.display = 'block';
  updateStatusIndicator('running', period);

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const res  = await fetch('/status');
      const data = await res.json();

      if (data.status !== 'running') {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('generate-btn').disabled = false;
        document.getElementById('progress-bar').style.display = 'none';
        updateStatusIndicator(data.status, null);

        if (data.status === 'success') {
          setRunStatus('Digest generated! Refreshing results (this may take ~30 s for GitHub Pages to update)...');
          // GitHub Pages cache can lag; retry a few times
          reloadDigestWithRetry(5, 8000);
        } else {
          const errMsg = data.last_error ? ` — ${data.last_error}` : '';
          setRunStatus(`Generation failed${errMsg}`);
        }
      }
    } catch (e) {
      console.warn('Status poll error:', e);
    }
  }, 3000);
}

async function reloadDigestWithRetry(attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    const prev = digestData?.weeks?.[0]?.date;
    await loadDigest();
    if ((digestData?.weeks?.[0]?.date ?? '') !== prev) {
      setRunStatus('');
      return;
    }
  }
  setRunStatus('Done. If the new digest does not appear, refresh the page in a moment.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Status indicator (header) ─────────────────────────────────────────────
function updateStatusIndicator(status, period) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'status-dot';

  if (status === 'running') {
    dot.classList.add('running');
    const lbl = PERIOD_LABELS[period] || period || '';
    text.textContent = `Generating${lbl ? ' ' + lbl : ''} Digest...`;
    setRunStatus('Fetching papers from PubMed and summarizing with Claude. This may take 2–3 minutes.');
  } else if (status === 'success') {
    dot.classList.add('success');
    text.textContent = 'Last run: success';
  } else if (status && status.startsWith('error')) {
    dot.classList.add('error');
    text.textContent = 'Last run: error';
  } else {
    dot.classList.add('idle');
    text.textContent = 'Ready';
  }
}

function setRunStatus(msg) {
  const el = document.getElementById('run-status');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ── Render digest entry ───────────────────────────────────────────────────
function renderDigest(entry, index) {
  activeIndex = index;

  const periodBadge = entry.period ? PERIOD_LABELS[entry.period] || entry.period : '';
  document.getElementById('digest-title').textContent = entry.label || entry.period || 'Digest';
  document.getElementById('digest-subtitle').textContent =
    `${entry.paper_count ?? (entry.papers?.length ?? 0)} papers · Generated ${fmtDate(entry.date)}`;

  const pdfBtn = document.getElementById('pdf-btn');
  if (entry.pdf_key) {
    pdfBtn.href = `${S3_BASE}/${entry.pdf_key}`;
    pdfBtn.style.display = 'inline-block';
  } else {
    pdfBtn.style.display = 'none';
  }

  const grid = document.getElementById('papers-grid');
  const papers = entry.papers || [];
  if (papers.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128203;</div><p>No papers found for this period.</p></div>`;
    return;
  }
  grid.innerHTML = papers
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .map((p, i) => renderCard(p, i + 1))
    .join('');

  // Sync history highlight
  document.querySelectorAll('.history-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
}

// ── Paper card ────────────────────────────────────────────────────────────
function renderCard(paper, num) {
  const score  = paper.relevance_score ?? 0;
  const stars  = Array.from({ length: 5 }, (_, i) =>
    `<span class="${i < score ? 'star-filled' : 'star-empty'}">&#9733;</span>`
  ).join('');

  const design  = paper.study_design ? `<span class="tag tag-design">${esc(paper.study_design)}</span>` : '';
  const sample  = paper.sample_size  ? `<span class="tag tag-sample">n&nbsp;=&nbsp;${esc(paper.sample_size)}</span>` : '';
  const pubmed  = paper.url || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : '');
  const pmLink  = pubmed ? `<a href="${pubmed}" target="_blank" rel="noopener" class="pubmed-link">PubMed &#8594;</a>` : '';

  const keyFinding    = paper.key_finding    || paper.one_line         || '—';
  const takeaway      = paper.clinical_takeaway                        || '—';

  return `
<div class="paper-card">
  <div class="paper-card-header">
    <div class="paper-number">${num}</div>
    <div class="paper-title">${esc(paper.title)}</div>
    <div class="relevance-stars" title="Relevance ${score}/5">${stars}</div>
  </div>
  <div class="paper-body">
    <div>
      <div class="paper-section-label">Key Finding</div>
      <div class="paper-section-text">${esc(keyFinding)}</div>
    </div>
    <div>
      <div class="paper-section-label">Clinical Takeaway</div>
      <div class="paper-section-text">${esc(takeaway)}</div>
    </div>
  </div>
  <div class="paper-footer">
    ${design}${sample}${pmLink}
  </div>
</div>`;
}

// ── History list ──────────────────────────────────────────────────────────
function renderHistory(weeks) {
  const panel = document.getElementById('history-panel');
  if (!weeks || weeks.length <= 1) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const list = document.getElementById('history-list');
  list.innerHTML = weeks.map((w, i) => {
    const periodBadge = w.period ? PERIOD_LABELS[w.period] || w.period : '';
    return `
<li class="history-item ${i === 0 ? 'active' : ''}" data-index="${i}">
  <div>
    <div class="history-period">
      ${esc(w.label || w.period || w.date || 'Digest')}
      ${periodBadge ? `<span class="history-period-badge">${esc(periodBadge)}</span>` : ''}
    </div>
    <div class="history-meta">Generated ${fmtDate(w.date)}</div>
  </div>
  <span class="history-count">${w.paper_count ?? (w.papers?.length ?? 0)} papers</span>
</li>`;
  }).join('');

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const i = parseInt(item.dataset.index, 10);
      renderDigest(weeks[i], i);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
