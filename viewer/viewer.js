import { PDFHighlightViewer, setupWorker } from '@epam/pdf-highlighter-kit';
import * as pdfjsLib from 'pdfjs-dist';

// ── Risk → highlight color map ──
const RISK_STYLES = {
  high:    { backgroundColor: 'rgba(224, 80, 80, 0.2)',  borderColor: '#e05050' },
  medium:  { backgroundColor: 'rgba(224, 176, 64, 0.2)', borderColor: '#e0b040' },
  low:     { backgroundColor: 'transparent',             borderColor: 'transparent' },
  unknown: { backgroundColor: 'transparent',             borderColor: 'transparent' }
};

const RISK_LABELS = { low: 'Standard', medium: 'Review', high: 'Flagged', unknown: 'Not found' };

// ── DOM refs ──
const container = document.getElementById('viewerContainer');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingStepEl = document.getElementById('loadingStep');
const termChipsEl = document.getElementById('termChips');
const panelCards = document.getElementById('panelCards');

function setStep(msg) { loadingStepEl.textContent = msg; }

// ── Fetch PDF base64 via background service worker ──
function fetchPDFBase64(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fetchPDF', url }, (res) => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
      if (!res.success) { reject(new Error(res.error)); return; }
      resolve(res.data);
    });
  });
}

// ── Base64 → ArrayBuffer ──
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── Section-based highlight building ──
// Strategy: join each page's text items into one string, use indexOf to find
// the section heading, map character offsets back to text items, and highlight
// from the heading until the next section heading (or end of page range).
async function buildHighlights(pdfDoc, termData, sections) {
  const highlights = [];

  const pageCache = {};
  async function getPageData(pageNum) {
    if (!pageCache[pageNum]) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      pageCache[pageNum] = { viewport, textContent };
    }
    return pageCache[pageNum];
  }

  for (const term of termData) {
    const sourceIndices = term.source_sections || [];
    if (sourceIndices.length === 0) continue;

    const risk = term.risk || 'unknown';
    const style = RISK_STYLES[risk] || RISK_STYLES.unknown;
    const bboxes = [];

    for (const sectionIdx of sourceIndices) {
      const section = sections[sectionIdx];
      if (!section) continue;

      const nextSection = sections[sectionIdx + 1] || null;
      const headingLower = section.heading.toLowerCase().trim();
      const nextHeadingLower = nextSection ? nextSection.heading.toLowerCase().trim() : null;

      for (let pageNum = section.startPage; pageNum <= section.endPage; pageNum++) {
        const { viewport, textContent } = await getPageData(pageNum);
        const viewportHeight = viewport.height;
        const items = textContent.items;

        // Build concatenated page text and character-offset map
        const offsets = []; // { charStart } per item
        let charPos = 0;
        for (const item of items) {
          offsets.push({ charStart: charPos });
          charPos += (item.str || '').length + 1; // +1 for the join space
        }
        const pageTextLower = items.map(it => (it.str || '')).join(' ').toLowerCase();

        // Determine start item index
        let startItem = 0;
        if (pageNum === section.startPage) {
          const hPos = pageTextLower.indexOf(headingLower);
          if (hPos >= 0) {
            for (let i = 0; i < items.length; i++) {
              if (offsets[i].charStart + (items[i].str || '').length > hPos) {
                startItem = i;
                break;
              }
            }
          }
        }

        // Determine end item index
        let endItem = items.length;
        if (pageNum === section.endPage && nextHeadingLower) {
          const searchFrom = (pageNum === section.startPage && startItem > 0)
            ? offsets[startItem].charStart + headingLower.length
            : 0;
          const nPos = pageTextLower.indexOf(nextHeadingLower, searchFrom);
          if (nPos >= 0) {
            for (let i = 0; i < items.length; i++) {
              if (offsets[i].charStart >= nPos) {
                endItem = i;
                break;
              }
            }
          }
        }

        // Collect bboxes for items in the range
        for (let i = startItem; i < endItem; i++) {
          const item = items[i];
          if (!item.str || !item.str.trim() || !item.width) continue;

          const hPad = item.height * 0.12;
          const topPad = item.height * 0.1;
          const botPad = item.height * 0.3;
          const x1 = item.transform[4] - hPad;
          const x2 = x1 + item.width + hPad * 2;
          const y2 = viewportHeight - item.transform[5] + botPad;
          const y1 = y2 - item.height - topPad;

          bboxes.push({ x1, y1, x2, y2, page: pageNum });
        }
      }
    }

    if (bboxes.length === 0) continue;
    const merged = mergeBboxes(bboxes);

    highlights.push({
      id: term.id,
      bboxes: merged,
      style: { ...style, opacity: 0.8, hoverOpacity: 1.0 },
      tooltipText: term.label,
      metadata: { risk }
    });
  }

  return highlights;
}

// ── Merge nearby bboxes on the same page into combined boxes ──
function mergeBboxes(bboxes) {
  // Group by page
  const byPage = {};
  for (const b of bboxes) {
    (byPage[b.page] ||= []).push(b);
  }

  const result = [];

  for (const [page, boxes] of Object.entries(byPage)) {
    // Sort top-to-bottom, then left-to-right
    boxes.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);

    const merged = [{ ...boxes[0] }];

    for (let i = 1; i < boxes.length; i++) {
      const curr = boxes[i];
      const prev = merged[merged.length - 1];
      // Average line height for proximity threshold
      const lineH = (prev.y2 - prev.y1 + curr.y2 - curr.y1) / 2;
      // Merge if vertically close (within 1.2x line height gap)
      const gap = curr.y1 - prev.y2;

      if (gap < lineH * 1.2) {
        // Expand prev to cover both
        prev.x1 = Math.min(prev.x1, curr.x1);
        prev.x2 = Math.max(prev.x2, curr.x2);
        prev.y1 = Math.min(prev.y1, curr.y1);
        prev.y2 = Math.max(prev.y2, curr.y2);
      } else {
        merged.push({ ...curr });
      }
    }

    result.push(...merged);
  }

  return result;
}

// ── Build sidebar panel cards ──
function buildPanelCards(termData, highlights, viewer, sections) {
  panelCards.innerHTML = '';

  const highlightedIds = new Set(highlights.map(h => h.id));

  for (const term of termData) {
    const risk = term.risk || 'unknown';
    const hasHighlights = highlightedIds.has(term.id);
    const sectionCount = (term.source_sections || []).length;

    const card = document.createElement('div');
    card.className = `panel-card risk-${risk}`;
    card.dataset.termId = term.id;

    // Build source sections info
    const sourceSections = (term.source_sections || [])
      .map(i => sections[i])
      .filter(Boolean);
    const sourceInfo = sourceSections.length > 0
      ? sourceSections.map(s => s.heading).join(', ')
      : '';

    card.innerHTML = `
      <div class="panel-card-header">
        <div class="panel-card-left">
          <div class="panel-dot ${risk}"></div>
          <span class="panel-card-label">${term.label}</span>
        </div>
        <div class="panel-card-right">
          <span class="panel-card-value">${term.value || ''}</span>
          <span class="panel-arrow">▼</span>
        </div>
      </div>
      <div class="panel-card-body">
        <span class="panel-risk-badge ${risk}">${RISK_LABELS[risk] || 'Unknown'}</span>
        <div class="panel-explanation">${term.explanation || ''}</div>
        ${term.quoted_text
          ? `<div class="panel-quote" style="font-style:italic;font-size:11px;color:#7a8a9a;background:#1e2d3d;border-left:2px solid #c8b88a;padding:6px 8px;margin:6px 0;border-radius:0 4px 4px 0;">"${term.quoted_text}"</div>` : ''}
        ${term.citation && term.citation !== 'No specific regulation applies'
          ? `<div class="panel-citation">📋 ${term.citation}</div>` : ''}
        ${term.market_note
          ? `<div class="panel-market">${term.market_note}</div>` : ''}
        ${sectionCount > 0
          ? `<div class="panel-matches">${sectionCount} section${sectionCount !== 1 ? 's' : ''} cited${sourceInfo ? ': ' + sourceInfo : ''}</div>` : ''}
      </div>
    `;

    // Accordion toggle
    card.querySelector('.panel-card-header').addEventListener('click', () => {
      const wasOpen = card.classList.contains('open');
      // Close all
      panelCards.querySelectorAll('.panel-card').forEach(c => {
        c.classList.remove('open', 'active');
      });
      if (!wasOpen) {
        card.classList.add('open', 'active');
        setActiveTermHighlights(term.id);
        // Scroll to first highlight in PDF
        if (hasHighlights) {
          viewer.goToHighlight(term.id, 0);
        }
      } else {
        setActiveTermHighlights(null);
      }
      // Update header chips
      syncChipActive(term.id, !wasOpen);
    });

    panelCards.appendChild(card);
  }
}

// ── Visible outline styles for low/unknown when selected ──
const ACTIVE_STYLES = {
  low:     { backgroundColor: 'rgba(61, 184, 122, 0.08)', borderColor: '#3db87a', borderWidth: '2px' },
  unknown: { backgroundColor: 'rgba(200, 184, 138, 0.06)', borderColor: '#c8b88a', borderWidth: '2px' }
};
const HIDDEN_STYLE = { backgroundColor: 'transparent', borderColor: 'transparent' };

let _viewer = null;
let _termRiskMap = {};
let _activeTermId = null;

// ── Show/hide highlights for low/unknown risk terms ──
function setActiveTermHighlights(termId) {
  // Reset previous active term if it was low/unknown
  if (_activeTermId && (_termRiskMap[_activeTermId] === 'low' || _termRiskMap[_activeTermId] === 'unknown')) {
    _viewer.updateHighlightStyle(_activeTermId, HIDDEN_STYLE);
  }

  _activeTermId = termId;

  // If new term is low/unknown, make it visible
  if (termId) {
    const risk = _termRiskMap[termId];
    if (risk === 'low' || risk === 'unknown') {
      _viewer.updateHighlightStyle(termId, ACTIVE_STYLES[risk]);
    }
  }
}

// ── Sync header chip active state with panel ──
function syncChipActive(termId, isActive) {
  termChipsEl.querySelectorAll('.term-chip').forEach(c => c.classList.remove('active'));
  if (isActive) {
    const chip = termChipsEl.querySelector(`.term-chip[data-term-id="${termId}"]`);
    if (chip) chip.classList.add('active');
  }
}

// ── Open a specific term card in the sidebar ──
function openPanelCard(termId) {
  const card = panelCards.querySelector(`.panel-card[data-term-id="${termId}"]`);
  if (!card) return;

  // Close others, open this one
  panelCards.querySelectorAll('.panel-card').forEach(c => {
    c.classList.remove('open', 'active');
  });
  card.classList.add('open', 'active');

  // Show highlight outline for this term
  setActiveTermHighlights(termId);

  // Scroll card into view in the panel
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Sync chip
  syncChipActive(termId, true);
}

// ── Main initialization ──
async function init() {
  try {
    setStep('Reading analysis data...');
    const stored = await chrome.storage.local.get(['viewerTerms', 'viewerSections', 'pdfURL']);

    if (!stored.pdfURL) {
      setStep('No PDF URL found. Please analyze a lease first.');
      return;
    }

    const termRiskMap = {};
    const termData = stored.viewerTerms || [];
    const sections = stored.viewerSections || [];
    for (const t of termData) {
      termRiskMap[t.id] = t.risk;
    }
    _termRiskMap = termRiskMap;

    setStep('Fetching PDF...');
    const pdfBase64 = await fetchPDFBase64(stored.pdfURL);
    const pdfArrayBuffer = base64ToArrayBuffer(pdfBase64);

    setStep('Setting up PDF engine...');
    const workerSrc = chrome.runtime.getURL('node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    await setupWorker({ workerSrc });

    setStep('Initializing viewer...');
    const viewer = new PDFHighlightViewer();
    _viewer = viewer;
    await viewer.init(container, {
      enableTextSelection: true,
      enableVirtualScrolling: true,
      bufferPages: 3,
      maxCachedPages: 20
    });

    setStep('Rendering PDF...');
    await viewer.loadPDF(pdfArrayBuffer.slice(0));

    setStep('Highlighting cited sections...');
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const highlights = await buildHighlights(pdfDoc, termData, sections);

    if (highlights.length > 0) {
      viewer.loadHighlights(highlights);
    }

    // Build sidebar panel cards
    buildPanelCards(termData, highlights, viewer, sections);

    // Highlight click → open corresponding card in sidebar + flash
    container.addEventListener('click', (e) => {
      const highlight = e.target.closest('.highlight, .highlight-wrapper');
      if (highlight) {
        const termId = highlight.getAttribute('data-term-id');
        if (termId) {
          // Flash effect
          highlight.classList.remove('highlight-click-flash');
          void highlight.offsetWidth;
          highlight.classList.add('highlight-click-flash');
          highlight.addEventListener('animationend', () => {
            highlight.classList.remove('highlight-click-flash');
          }, { once: true });

          // Open the matching card in sidebar
          openPanelCard(termId);
        }
      }
    });

    // Header term chips
    renderTermChips(termData, highlights, viewer);

    // Zoom controls
    const zoomLevelEl = document.getElementById('zoomLevel');
    function updateZoomLabel() {
      zoomLevelEl.textContent = Math.round(viewer.getZoom() * 100) + '%';
    }
    document.getElementById('zoomIn').addEventListener('click', () => { viewer.zoomIn(); updateZoomLabel(); });
    document.getElementById('zoomOut').addEventListener('click', () => { viewer.zoomOut(); updateZoomLabel(); });
    document.getElementById('zoomReset').addEventListener('click', () => { viewer.resetZoom(); updateZoomLabel(); });
    updateZoomLabel();

    // Hide loading
    loadingOverlay.classList.add('hidden');

    // Close button + Escape
    document.getElementById('closeBtn').addEventListener('click', () => window.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.close();
    });

  } catch (err) {
    console.error('Viewer init error:', err);
    setStep('Error: ' + err.message);
  }
}

// ── Render clickable term chips in the header ──
function renderTermChips(termData, highlights, viewer) {
  termChipsEl.innerHTML = '';

  const highlightedIds = new Set(highlights.map(h => h.id));

  for (const term of termData) {
    if (!highlightedIds.has(term.id)) continue;

    const chip = document.createElement('button');
    chip.className = `term-chip risk-${term.risk}`;
    chip.dataset.termId = term.id;
    chip.textContent = term.label;
    chip.title = `Jump to ${term.label}`;

    chip.addEventListener('click', () => {
      // Open sidebar card + scroll PDF to first match
      openPanelCard(term.id);
      viewer.goToHighlight(term.id, 0);
    });

    termChipsEl.appendChild(chip);
  }
}

// ── Boot ──
init();
