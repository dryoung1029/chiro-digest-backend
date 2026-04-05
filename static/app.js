/**
 * Chiro Digest — frontend
 */

const S3_BASE       = 'https://chiro-digest-userdata.s3.us-west-2.amazonaws.com';
const PERIOD_LABELS = { week: '1 Week', month: '1 Month', '3months': '3 Months', '6months': '6 Months' };

let selectedPeriod = 'week';
let pollInterval   = null;
let digestData     = null;
let activeIndex    = 0;
let currentTerms   = [];
let pendingTerms   = [];
let activeCategory = 'all';
let activeType     = 'all';
let sortMode       = 'relevance';
let currentPapers  = [];  // papers for the currently displayed digest

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupPeriodButtons();
  document.getElementById('generate-btn').addEventListener('click', generateDigest);
  setupSearchTerms();
  setupFilters();
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

// ── Filters ───────────────────────────────────────────────────────────────
function setupFilters() {
  document.getElementById('category-filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    document.querySelectorAll('#category-filters .filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCategory = btn.dataset.category;
    activeType = 'all';
    document.querySelectorAll('#type-filters .filter-chip').forEach(b => b.classList.remove('active'));
    const allType = document.querySelector('#type-filters .filter-chip[data-type="all"]');
    if (allType) allType.classList.add('active');
    applyFilters();
  });

  document.getElementById('type-filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    document.querySelectorAll('#type-filters .filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeType = btn.dataset.type;
    applyFilters();
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    sortMode = e.target.value;
    applyFilters();
  });
}

function getCategory(studyDesign) {
  if (!studyDesign) return 'other';
  const sd = studyDesign.toLowerCase();
  if (/\b(rct|randomized|randomised|trial)\b/.test(sd)) return 'trial';
  if (/\b(review|meta.?analysis|scoping)\b/.test(sd)) return 'review';
  if (/\bcase\b/.test(sd)) return 'case_report';
  return 'observational';
}

function buildTypeFilters(papers) {
  const types = [...new Set(papers.map(p => p.study_design).filter(Boolean))].sort();
  const group = document.getElementById('type-filter-group');
  const container = document.getElementById('type-filters');
  if (types.length === 0) { group.style.display = 'none'; return; }

  group.style.display = 'flex';
  container.innerHTML = `<button class="filter-chip active" data-type="all">All</button>` +
    types.map(t => `<button class="filter-chip" data-type="${esc(t)}">${esc(t)}</button>`).join('');
}

function applyFilters() {
  let papers = [...currentPapers];

  // Category filter
  if (activeCategory !== 'all') {
    papers = papers.filter(p => getCategory(p.study_design) === activeCategory);
  }

  // Type filter
  if (activeType !== 'all') {
    papers = papers.filter(p => p.study_design === activeType);
  }

  // Sort
  if (sortMode === 'relevance') {
    papers.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
  } else {
    papers.sort((a, b) => (a.study_design || '').localeCompare(b.study_design || ''));
  }

  const grid = document.getElementById('papers-grid');
  if (papers.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128269;</div><p>No papers match this filter.</p></div>`;
    return;
  }
  grid.innerHTML = papers.map((p, i) => renderCard(p, i + 1)).join('');
}

// ── Search terms ──────────────────────────────────────────────────────────
function setupSearchTerms() {
  const input = document.getElementById('terms-input');
  document.getElementById('add-term-btn').addEventListener('click', () => addTerm(input.value));
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
  } catch (e) { console.warn('Could not load search terms:', e); }
}

function renderTerms() {
  const container = document.getElementById('terms-chips');
  container.innerHTML = pendingTerms.map((term, i) => `
    <div class="term-chip">
      <span>${esc(term)}</span>
      <button class="term-remove" data-index="${i}" title="Remove">&times;</button>
    </div>`).join('');
  container.querySelectorAll('.term-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingTerms.splice(parseInt(btn.dataset.index, 10), 1);
      renderTerms();
    });
  });
  const dirty = JSON.stringify(pendingTerms) !== JSON.stringify(currentTerms);
  document.getElementById('terms-unsaved').style.display = dirty ? 'inline' : 'none';
  document.getElementById('save-terms-btn').style.display = dirty ? 'inline-block' : 'none';
}

function addTerm(raw) {
  const term = raw.trim();
  if (!term || pendingTerms.includes(term)) { document.getElementById('terms-input').value = ''; return; }
  pendingTerms.push(term);
  document.getElementById('terms-input').value = '';
  renderTerms();
}

async function saveTerms() {
  const btn = document.getElementById('save-terms-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  try {
    const res = await fetch('/search-terms', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: pendingTerms }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    currentTerms = [...pendingTerms];
    renderTerms();
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
  } catch (e) {
    btn.textContent = 'Error'; btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Save'; }, 2000);
  }
}

// ── Load digest ───────────────────────────────────────────────────────────
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
  } catch (e) { console.warn('Could not load digest:', e); }
}

// ── Status check on load ──────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res  = await fetch('/status');
    const data = await res.json();
    if (data.status === 'running') startPolling(data.period || 'week', data.step);
    else updateStatusIndicator(data.status, null);
  } catch (e) {}
}

// ── Generate ──────────────────────────────────────────────────────────────
async function generateDigest() {
  try {
    const res = await fetch(`/run?period=${selectedPeriod}`, { method: 'POST' });
    if (res.status === 409) { setRunStatus('A digest is already being generated. Please wait...'); return; }
    if (!res.ok) { const err = await res.json().catch(() => ({})); setRunStatus(`Error: ${err.detail || res.statusText}`); return; }
    startPolling(selectedPeriod, null);
  } catch (e) { setRunStatus(`Failed to start: ${e.message}`); }
}

// ── Polling ───────────────────────────────────────────────────────────────
function startPolling(period, initialStep) {
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('step-progress').style.display = 'block';
  document.getElementById('run-status').style.display = 'none';
  updateStatusIndicator('running', period);
  if (initialStep) document.getElementById('step-status').textContent = initialStep;

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const res  = await fetch('/status');
      const data = await res.json();
      if (data.step) document.getElementById('step-status').textContent = data.step;
      if (data.status !== 'running') {
        clearInterval(pollInterval); pollInterval = null;
        document.getElementById('generate-btn').disabled = false;
        document.getElementById('step-progress').style.display = 'none';
        updateStatusIndicator(data.status, null);
        const result = data.last_result || {};
        if (result.warning) {
          setRunStatus(`⚠️ ${result.warning}`);
        } else if (data.status === 'success') {
          setRunStatus(`Done — ${result.total} papers summarized. Loading results...`);
          await sleep(1500);
          await loadDigest();
          setRunStatus('');
        } else {
          setRunStatus(`Generation failed${data.last_error ? ' — ' + data.last_error : ''}`);
        }
      }
    } catch (e) { console.warn('Poll error:', e); }
  }, 2500);
}

function updateStatusIndicator(status, period) {
  const dot = document.getElementById('status-dot'), text = document.getElementById('status-text');
  dot.className = 'status-dot';
  if (status === 'running') {
    dot.classList.add('running');
    text.textContent = `Generating${period ? ' ' + (PERIOD_LABELS[period] || period) : ''} Digest...`;
  } else if (status === 'success') { dot.classList.add('success'); text.textContent = 'Last run: success'; }
  else if (status?.startsWith('error')) { dot.classList.add('error'); text.textContent = 'Last run: error'; }
  else { dot.classList.add('idle'); text.textContent = 'Ready'; }
}

function setRunStatus(msg) {
  const el = document.getElementById('run-status');
  el.textContent = msg; el.style.display = msg ? 'block' : 'none';
}

// ── Render digest entry ───────────────────────────────────────────────────
function renderDigest(entry, index) {
  activeIndex = index;
  activeCategory = 'all'; activeType = 'all'; sortMode = 'relevance';
  document.getElementById('sort-select').value = 'relevance';
  document.querySelectorAll('#category-filters .filter-chip').forEach((b, i) => b.classList.toggle('active', i === 0));

  document.getElementById('digest-title').textContent = entry.label || entry.period || 'Digest';
  document.getElementById('digest-subtitle').textContent =
    `${entry.paper_count ?? (entry.papers?.length ?? 0)} papers · Generated ${fmtDate(entry.date)}`;

  const pdfBtn = document.getElementById('pdf-btn');
  if (entry.pdf_key) { pdfBtn.href = `${S3_BASE}/${entry.pdf_key}`; pdfBtn.style.display = 'inline-block'; }
  else { pdfBtn.style.display = 'none'; }

  // Briefing
  const briefingSection = document.getElementById('briefing-section');
  if (entry.digest_summary) {
    document.getElementById('briefing-text').innerHTML =
      entry.digest_summary.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('');
    briefingSection.style.display = 'block';
  } else {
    briefingSection.style.display = 'none';
  }

  currentPapers = entry.papers || [];
  const grid = document.getElementById('papers-grid');

  if (currentPapers.length === 0) {
    document.getElementById('filter-bar').style.display = 'none';
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128203;</div><p>No papers found for this period.</p></div>`;
    return;
  }

  document.getElementById('filter-bar').style.display = 'flex';
  buildTypeFilters(currentPapers);
  applyFilters();

  document.querySelectorAll('.history-item').forEach((el, i) => el.classList.toggle('active', i === index));
}

// ── Paper card ────────────────────────────────────────────────────────────
function getFullTextLink(paper) {
  if (paper.pmc_id) {
    return { url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${paper.pmc_id}/`, label: 'Full Text', cls: 'full-text' };
  }
  if (paper.doi) {
    return { url: `https://doi.org/${esc(paper.doi)}`, label: 'View Article', cls: '' };
  }
  const pubmedUrl = paper.url || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : null);
  if (pubmedUrl) {
    return { url: pubmedUrl, label: 'Abstract', cls: '' };
  }
  return null;
}

function renderCard(paper, num) {
  const score = paper.relevance_score ?? 0;
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<span class="${i < score ? 'star-filled' : 'star-empty'}">&#9733;</span>`
  ).join('');
  const design  = paper.study_design ? `<span class="tag tag-design">${esc(paper.study_design)}</span>` : '';
  const sample  = paper.sample_size  ? `<span class="tag tag-sample">n&nbsp;=&nbsp;${esc(String(paper.sample_size))}</span>` : '';

  const ftLink   = getFullTextLink(paper);
  const pubmedUrl = paper.url || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : null);

  // Build link row: full-text (if available) + always show abstract/pubmed separately
  let linksHtml = '';
  if (ftLink) {
    linksHtml += `<a href="${ftLink.url}" target="_blank" rel="noopener" class="paper-link ${ftLink.cls}">${ftLink.label} &#8599;</a>`;
    // If full text is PMC or DOI, also show the PubMed abstract link separately
    if (paper.pmc_id && pubmedUrl) {
      linksHtml += `<span class="paper-link-sep">|</span><a href="${pubmedUrl}" target="_blank" rel="noopener" class="paper-link">Abstract</a>`;
    }
  }

  return `
<div class="paper-card" data-category="${esc(getCategory(paper.study_design))}" data-type="${esc(paper.study_design || '')}">
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
  <div class="paper-footer">
    ${design}${sample}
    ${linksHtml ? `<div class="paper-links">${linksHtml}</div>` : ''}
  </div>
</div>`;
}

// ── History ───────────────────────────────────────────────────────────────
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

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.delete-digest-btn, .delete-confirm')) return;
      renderDigest(weeks[parseInt(item.dataset.index, 10)], parseInt(item.dataset.index, 10));
    });
  });
  list.querySelectorAll('.delete-digest-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showDeleteConfirm(btn.closest('.history-item'), btn.dataset.date, weeks);
    });
  });
}

function showDeleteConfirm(li, date, weeks) {
  const existing = li.parentElement.querySelector('.delete-confirm-row');
  if (existing) { existing.remove(); return; }
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
  row.querySelector('.btn-confirm-delete').addEventListener('click', () => deleteDigest(date, row));
  li.after(row);
}

async function deleteDigest(date, confirmRow) {
  const btn = confirmRow.querySelector('.btn-confirm-delete');
  btn.textContent = 'Deleting...'; btn.disabled = true;
  try {
    const res = await fetch(`/digest?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    confirmRow.remove();
    digestData.weeks = digestData.weeks.filter(w => w.date !== date);
    const weeks = digestData.weeks;
    if (weeks.length > 0) { renderDigest(weeks[0], 0); renderHistory(weeks); }
    else {
      document.getElementById('digest-title').textContent = 'Latest Digest';
      document.getElementById('digest-subtitle').textContent = '';
      document.getElementById('pdf-btn').style.display = 'none';
      document.getElementById('briefing-section').style.display = 'none';
      document.getElementById('filter-bar').style.display = 'none';
      document.getElementById('papers-grid').innerHTML =
        `<div class="empty-state"><div class="empty-icon">&#128203;</div><p>No digest available yet.</p></div>`;
      document.getElementById('history-panel').style.display = 'none';
    }
  } catch (e) {
    btn.textContent = 'Error'; btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Delete'; btn.disabled = false; }, 2000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
