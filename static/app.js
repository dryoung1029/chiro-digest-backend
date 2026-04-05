/**
 * Chiro Digest — frontend
 */

const S3_BASE       = 'https://chiro-digest-userdata.s3.us-west-2.amazonaws.com';
const PERIOD_LABELS = { week: '1 Week', month: '1 Month', '3months': '3 Months', '6months': '6 Months' };

let selectedPeriod   = 'week';
let pollInterval     = null;
let digestData       = null;
let activeIndex      = 0;
let currentTerms     = [];   // terms as loaded from server
let pendingTerms     = [];   // terms with unsaved edits

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupPeriodButtons();
  document.getElementById('generate-btn').addEventListener('click', generateDigest);
  setupSearchTerms();
  await Promise.all([loadDigest(), loadSearchTerms(), checkStatus()]);
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

// ── Search terms ──────────────────────────────────────────────────────────
function setupSearchTerms() {
  const input  = document.getElementById('terms-input');
  const addBtn = document.getElementById('add-term-btn');

  addBtn.addEventListener('click', () => addTerm(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addTerm(input.value); });
  document.getElementById('save-terms-btn').addEventListener('click', saveTerms);
}

async function loadSearchTerms() {
  try {
    const res  = await fetch('/search-terms');
    const data = await res.json();
    currentTerms = data.terms || [];
    pendingTerms = [...currentTerms];
    renderTerms();
  } catch (e) {
    console.warn('Could not load search terms:', e);
  }
}

function renderTerms() {
  const container = document.getElementById('terms-chips');
  container.innerHTML = pendingTerms.map((term, i) => `
    <div class="term-chip">
      <span>${esc(term)}</span>
      <button class="term-remove" data-index="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.term-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingTerms.splice(parseInt(btn.dataset.index, 10), 1);
      markTermsDirty();
      renderTerms();
    });
  });

  const dirty = JSON.stringify(pendingTerms) !== JSON.stringify(currentTerms);
  document.getElementById('terms-unsaved').style.display = dirty ? 'inline' : 'none';
  document.getElementById('save-terms-btn').style.display = dirty ? 'inline-block' : 'none';
}

function addTerm(raw) {
  const term = raw.trim();
  if (!term) return;
  if (pendingTerms.includes(term)) {
    document.getElementById('terms-input').value = '';
    return;
  }
  pendingTerms.push(term);
  document.getElementById('terms-input').value = '';
  markTermsDirty();
  renderTerms();
}

function markTermsDirty() {
  const dirty = JSON.stringify(pendingTerms) !== JSON.stringify(currentTerms);
  document.getElementById('terms-unsaved').style.display = dirty ? 'inline' : 'none';
  document.getElementById('save-terms-btn').style.display = dirty ? 'inline-block' : 'none';
}

async function saveTerms() {
  const btn = document.getElementById('save-terms-btn');
  btn.textContent = 'Saving...';
  btn.disabled = true;
  try {
    const res = await fetch('/search-terms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: pendingTerms }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    currentTerms = [...pendingTerms];
    renderTerms();
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
  } catch (e) {
    btn.textContent = 'Error';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Save'; }, 2000);
  }
}

// ── Load digest.json from GitHub Pages ───────────────────────────────────
async function loadDigest() {
  try {
    const res = await fetch('/digest');
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
      startPolling(data.period || 'week', data.step);
    } else {
      updateStatusIndicator(data.status, null);
    }
  } catch (e) { /* backend unavailable */ }
}

// ── Trigger new digest run ────────────────────────────────────────────────
async function generateDigest() {
  try {
    const res = await fetch(`/run?period=${selectedPeriod}`, { method: 'POST' });
    if (res.status === 409) { setRunStatus('A digest is already being generated. Please wait...'); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setRunStatus(`Error: ${err.detail || res.statusText}`);
      return;
    }
    startPolling(selectedPeriod, null);
  } catch (e) {
    setRunStatus(`Failed to start: ${e.message}`);
  }
}

// ── Poll /status while running ────────────────────────────────────────────
function startPolling(period, initialStep) {
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('step-progress').style.display = 'block';
  document.getElementById('run-status').style.display = 'none';
  updateStatusIndicator('running', period);
  if (initialStep) setStepDisplay(initialStep);

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const res  = await fetch('/status');
      const data = await res.json();

      if (data.step) setStepDisplay(data.step);

      if (data.status !== 'running') {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('generate-btn').disabled = false;
        document.getElementById('step-progress').style.display = 'none';
        updateStatusIndicator(data.status, null);

        if (data.status === 'success') {
          const result = data.last_result || {};
          if (result.warning) {
            setRunStatus(`⚠️ ${result.warning}`);
          } else {
            setRunStatus(`Done — ${result.total} papers summarized. Refreshing results...`);
            reloadDigestWithRetry();
          }
        } else {
          const errMsg = data.last_error ? ` — ${data.last_error}` : '';
          setRunStatus(`Generation failed${errMsg}`);
        }
      }
    } catch (e) { console.warn('Status poll error:', e); }
  }, 2500);
}

function setStepDisplay(msg) {
  document.getElementById('step-status').textContent = msg;
}

async function reloadDigestWithRetry() {
  await sleep(1500);
  await loadDigest();
  setRunStatus('');
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

  const grid   = document.getElementById('papers-grid');
  const papers = entry.papers || [];
  if (papers.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128203;</div><p>No papers found for this period.</p></div>`;
    return;
  }
  grid.innerHTML = [...papers]
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .map((p, i) => renderCard(p, i + 1))
    .join('');

  document.querySelectorAll('.history-item').forEach((el, i) => el.classList.toggle('active', i === index));
}

// ── Paper card ────────────────────────────────────────────────────────────
function renderCard(paper, num) {
  const score  = paper.relevance_score ?? 0;
  const stars  = Array.from({ length: 5 }, (_, i) =>
    `<span class="${i < score ? 'star-filled' : 'star-empty'}">&#9733;</span>`
  ).join('');
  const design = paper.study_design ? `<span class="tag tag-design">${esc(paper.study_design)}</span>` : '';
  const sample = paper.sample_size  ? `<span class="tag tag-sample">n&nbsp;=&nbsp;${esc(String(paper.sample_size))}</span>` : '';
  const pubmed = paper.url || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : '');
  const pmLink = pubmed ? `<a href="${pubmed}" target="_blank" rel="noopener" class="pubmed-link">PubMed &#8594;</a>` : '';

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
      <div class="paper-section-text">${esc(paper.key_finding || paper.one_line || '—')}</div>
    </div>
    <div>
      <div class="paper-section-label">Clinical Takeaway</div>
      <div class="paper-section-text">${esc(paper.clinical_takeaway || '—')}</div>
    </div>
  </div>
  <div class="paper-footer">${design}${sample}${pmLink}</div>
</div>`;
}

// ── History list ──────────────────────────────────────────────────────────
function renderHistory(weeks) {
  const panel = document.getElementById('history-panel');
  if (!weeks || weeks.length <= 1) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const list = document.getElementById('history-list');
  list.innerHTML = weeks.map((w, i) => {
    const badge = w.period ? PERIOD_LABELS[w.period] || w.period : '';
    return `
<li class="history-item ${i === 0 ? 'active' : ''}" data-index="${i}" data-date="${esc(w.date || '')}">
  <div class="history-item-main">
    <div class="history-period">
      ${esc(w.label || w.period || w.date || 'Digest')}
      ${badge ? `<span class="history-period-badge">${esc(badge)}</span>` : ''}
    </div>
    <div class="history-meta">Generated ${fmtDate(w.date)}</div>
  </div>
  <div class="history-item-right">
    <span class="history-count">${w.paper_count ?? (w.papers?.length ?? 0)} papers</span>
    <button class="delete-digest-btn" data-date="${esc(w.date || '')}" title="Delete this digest">&#128465;</button>
  </div>
</li>`;
  }).join('');

  // Click to view
  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.delete-digest-btn, .delete-confirm')) return;
      const i = parseInt(item.dataset.index, 10);
      renderDigest(weeks[i], i);
    });
  });

  // Delete buttons
  list.querySelectorAll('.delete-digest-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const li   = btn.closest('.history-item');
      const date = btn.dataset.date;
      showDeleteConfirm(li, date, weeks);
    });
  });
}

function showDeleteConfirm(li, date, weeks) {
  // Remove any existing confirmation row
  const existing = li.parentElement.querySelector('.delete-confirm-row');
  if (existing) existing.remove();
  if (existing && existing.dataset.date === date) return; // toggle off

  const row = document.createElement('li');
  row.className = 'delete-confirm';
  row.dataset.date = date;
  row.innerHTML = `
    <span>Delete digest for <strong>${esc(date)}</strong>? This cannot be undone.</span>
    <div class="delete-confirm-btns">
      <button class="btn-cancel">Cancel</button>
      <button class="btn-confirm-delete">Delete</button>
    </div>`;

  row.querySelector('.btn-cancel').addEventListener('click', () => row.remove());
  row.querySelector('.btn-confirm-delete').addEventListener('click', () => deleteDigest(date, row, weeks));

  li.after(row);
}

async function deleteDigest(date, confirmRow, weeks) {
  const btn = confirmRow.querySelector('.btn-confirm-delete');
  btn.textContent = 'Deleting...';
  btn.disabled = true;

  try {
    const res = await fetch(`/digest?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);

    // Remove from local data and re-render
    confirmRow.remove();
    digestData.weeks = digestData.weeks.filter(w => w.date !== date);
    const weeks = digestData.weeks;
    if (weeks.length > 0) {
      renderDigest(weeks[0], 0);
      renderHistory(weeks);
    } else {
      document.getElementById('digest-title').textContent = 'Latest Digest';
      document.getElementById('digest-subtitle').textContent = '';
      document.getElementById('pdf-btn').style.display = 'none';
      document.getElementById('papers-grid').innerHTML =
        `<div class="empty-state"><div class="empty-icon">&#128203;</div><p>No digest available yet. Generate one above to get started.</p></div>`;
      document.getElementById('history-panel').style.display = 'none';
    }
  } catch (e) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Delete'; btn.disabled = false; }, 2000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
