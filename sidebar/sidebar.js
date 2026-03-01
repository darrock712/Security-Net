// Handles Task 1 (summarize and review) and Task 2 (sets the user for priority and personalized experience)

// Grab all the elements we need
const stateIdle    = document.getElementById('stateIdle');
const stateLoading = document.getElementById('stateLoading');
const stateResults = document.getElementById('stateResults');
const loadingStep  = document.getElementById('loadingStep');
const termsList    = document.getElementById('termsList');
const priorityResults   = document.getElementById('priorityResults');
const priorityCardsList = document.getElementById('priorityCardsList');
const prioritySubmitBtn = document.getElementById('prioritySubmitBtn');
const priorityFreeText  = document.getElementById('priorityFreeText');

// Stores the lease summary so Task 2 can use it
let leaseSummaryCache = null;
// Stores extracted sections for follow-up context
let viewerSectionsCache = null;

// Set pdf.js worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// Close Button
document.getElementById('closeBtn').addEventListener('click', () => {
  window.parent.postMessage({ action: 'snClose' }, '*');
});

// Show/Hide States
function showState(name) {
  stateIdle.classList.remove('active');
  stateLoading.classList.remove('active');
  stateResults.classList.remove('active');
  document.getElementById('state' + name).classList.add('active');
}

function setLoadingStep(msg) {
  loadingStep.textContent = msg;
}

// Load Seattle Regulations
async function loadRegulations() {
  const url = chrome.runtime.getURL('info_base/seattle.json');
  const res = await fetch(url);
  return res.json();
}

// Call Gemini via the background service worker (optional pdfBase64 and schema for structured output)
function callGemini(prompt, pdfBase64, schema) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
      if (!apiKey) { reject(new Error('No API key')); return; }
      chrome.runtime.sendMessage(
        { action: 'callGemini', prompt, apiKey, pdfBase64, schema },
        (res) => {
          if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
          if (!res.success) { reject(new Error(res.error)); return; }
          resolve(res.data);
        }
      );
    });
  });
}

// Fetch the PDF as base64 via the background service worker
function fetchPDFBase64(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'fetchPDF', url },
      (res) => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
        if (!res.success) { reject(new Error(res.error)); return; }
        resolve(res.data);
      }
    );
  });
}

// ── PDF Text Extraction ──

// Convert base64 PDF to text pages using pdf.js
// Preserves line breaks by detecting Y-position changes between text items
async function extractPDFText(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    let text = '';
    let lastY = null;

    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform[5];

      // Detect line break: significant Y-position change between items
      if (lastY !== null && Math.abs(y - lastY) > (item.height || 5) * 0.5) {
        text += '\n';
      } else if (text.length > 0 && !text.endsWith('\n')) {
        text += ' ';
      }

      text += item.str;

      // pdf.js marks end-of-line items
      if (item.hasEOL) {
        text += '\n';
      }

      lastY = y;
    }

    pages.push({ page: i, text });
  }

  return pages;
}

// ── Section Splitting ──

// Detect section headers and split PDF text into logical sections
function splitIntoSections(pages) {
  // Patterns that indicate a section heading
  const headerPatterns = [
    /^([A-Z][A-Z\s/&'-]{2,})$/,                      // ALL CAPS lines (≥3 chars)
    /^\d+\.\s+.+/,                                     // Numbered: "1. Something"
    /^[A-Z]\.\s+.+/,                                   // Lettered: "A. Something"
    /^\([a-z]\)\s+.+/,                                 // Parenthesized letter: "(a) Something"
    /^\(\d+\)\s+.+/,                                   // Parenthesized number: "(1) Something"
    /^(?:Section|SECTION)\s+\d+/i,                     // "Section X"
    /^(?:Article|ARTICLE)\s+[IVXLCDM\d]+/i,           // "ARTICLE X" or Roman numerals
    /^(?:Part|PART)\s+[IVXLCDM\d]+/i,                 // "PART X"
  ];

  function isHeader(line) {
    const trimmed = line.trim();
    if (trimmed.length < 3) return false;
    return headerPatterns.some(p => p.test(trimmed));
  }

  const sections = [];
  let currentSection = null;

  for (const page of pages) {
    const lines = page.text.split(/\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isHeader(trimmed)) {
        // Save the previous section
        if (currentSection && currentSection.text.trim()) {
          currentSection.endPage = page.page;
          sections.push(currentSection);
        }
        // Start a new section
        currentSection = {
          index: sections.length,
          heading: trimmed,
          text: '',
          startPage: page.page,
          endPage: page.page
        };
      } else {
        if (!currentSection) {
          // Text before any header — create an intro section
          currentSection = {
            index: 0,
            heading: 'Introduction',
            text: '',
            startPage: page.page,
            endPage: page.page
          };
        }
        currentSection.text += trimmed + ' ';
        currentSection.endPage = page.page;
      }
    }
  }

  // Push the last section
  if (currentSection && currentSection.text.trim()) {
    sections.push(currentSection);
  }

  // Re-index
  sections.forEach((s, i) => { s.index = i; });

  return sections;
}

// ── Term IDs and Schemas ──

const TERM_IDS = [
  'security_deposit', 'monthly_rent', 'lease_term', 'late_fee',
  'early_termination', 'pet_policy', 'landlord_entry', 'utilities',
  'parking', 'rent_increase', 'subletting'
];

const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    section_mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section_index: { type: 'integer' },
          relevant_terms: {
            type: 'array',
            items: { type: 'string', enum: TERM_IDS }
          }
        },
        required: ['section_index', 'relevant_terms']
      }
    }
  },
  required: ['section_mappings']
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          value: { type: 'string' },
          risk: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
          explanation: { type: 'string' },
          citation: { type: 'string' },
          market_note: { type: 'string' },
          source_sections: { type: 'array', items: { type: 'integer' } },
          quoted_text: { type: 'string' }
        },
        required: ['id', 'label', 'value', 'risk', 'explanation', 'citation', 'source_sections']
      }
    }
  },
  required: ['terms']
};

// ── Prompts ──

function buildFilterPrompt(sections) {
  const sectionList = sections.map(s =>
    `[Section ${s.index}] "${s.heading}" (pages ${s.startPage}-${s.endPage}):\n${s.text.substring(0, 500)}`
  ).join('\n\n');

  return `
You are analyzing a residential lease document that has been split into sections.
For each section, identify which lease term IDs it is relevant to.

TERM IDS: ${TERM_IDS.join(', ')}

SECTIONS:
${sectionList}

For each section, return the section_index and an array of relevant_terms (term IDs from the list above).
Only include sections that are relevant to at least one term. Skip sections that are purely introductory or unrelated.
`.trim();
}

function buildAnalysisPrompt(termId, termLabel, relevantSections, regulations) {
  const sectionTexts = relevantSections.map(s =>
    `[Section ${s.index}: "${s.heading}" (pages ${s.startPage}-${s.endPage})]\n${s.text}`
  ).join('\n\n---\n\n');

  const regText = regulations.pages
    ? regulations.pages.map(p => p.text).join('\n')
    : JSON.stringify(regulations, null, 2);

  return `
You are analyzing a residential lease for the term "${termLabel}" (id: ${termId}).

RELEVANT LEASE SECTIONS:
${sectionTexts || 'No relevant sections found in the lease.'}

SEATTLE REGULATIONS REFERENCE:
${regText}

Analyze this specific term. Extract the value from the lease, assess the risk level, explain why, cite any applicable regulation, note how it compares to the Seattle market, identify which source sections you used, and quote the most relevant text from the lease.

If the term is not found in the provided sections, set value to "Not found" and risk to "unknown".
`.trim();
}

// ── Render Term Cards ──

function renderTerms(terms) {
  termsList.innerHTML = '';
  terms.forEach(term => {
    const card = document.createElement('div');
    card.className = `term-card risk-${term.risk}`;
    card.dataset.id = term.id;

    const riskLabel = { low: 'Standard', medium: 'Review', high: 'Flagged', unknown: 'Not found' }[term.risk] || '';
    const badgeClass = { low: 'badge-green', medium: 'badge-yellow', high: 'badge-red', unknown: 'badge-gray' }[term.risk] || 'badge-gray';

    // Build source sections display
    const sourceSections = term.source_sections || [];
    const sections = viewerSectionsCache || [];
    const sourceDisplay = sourceSections.length > 0
      ? `<div class="term-sources">Source: Sections ${sourceSections.map(i => {
          const sec = sections[i];
          return sec ? `${i} (${sec.heading})` : i;
        }).join(', ')}</div>`
      : '';

    // Build quoted text display
    const quoteDisplay = term.quoted_text
      ? `<div class="term-quote">"${term.quoted_text}"</div>`
      : '';

    card.innerHTML = `
      <div class="term-header">
        <div class="term-left">
          <div class="risk-dot ${term.risk}"></div>
          <span class="term-name">${term.label}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="term-value">${term.value}</span>
          <span class="expand-arrow">▼</span>
        </div>
      </div>
      <div class="term-body">
        <div class="term-explanation">${term.explanation}</div>
        ${quoteDisplay}
        ${sourceDisplay}
        <div class="term-meta">
          <span class="meta-badge ${badgeClass}">${riskLabel}</span>
          ${term.market_note ? `<span class="meta-badge badge-gray">${term.market_note}</span>` : ''}
        </div>
        ${term.citation !== 'No specific regulation applies' ? `<div class="term-citation">📋 ${term.citation}</div>` : ''}
        <div class="followup-area">
          <div class="followup-label">Ask a follow-up question about this clause:</div>
          <div class="followup-input-row">
            <input class="followup-input" type="text" placeholder="e.g. Is this normal? Can I negotiate this?" data-term-id="${term.id}">
            <button class="followup-btn" data-term-id="${term.id}">Ask</button>
          </div>
          <div class="followup-response" id="followup-${term.id}"></div>
        </div>
        <div class="correct-row">
          <button class="correct-btn" data-term-id="${term.id}">✎ This looks wrong</button>
        </div>
      </div>
    `;

    card.querySelector('.term-header').addEventListener('click', () => {
      card.classList.toggle('open');
    });

    termsList.appendChild(card);
  });

  // Follow up question handlers
  document.querySelectorAll('.followup-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFollowUp(btn.dataset.termId));
  });
  document.querySelectorAll('.followup-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleFollowUp(input.dataset.termId);
    });
  });

  // Correction handlers
  document.querySelectorAll('.correct-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCorrection(btn.dataset.termId));
  });
}

// Follow up Question Handler
async function handleFollowUp(termId) {
  const input = document.querySelector(`.followup-input[data-term-id="${termId}"]`);
  const btn = document.querySelector(`.followup-btn[data-term-id="${termId}"]`);
  const responseEl = document.getElementById(`followup-${termId}`);
  const question = input.value.trim();
  if (!question) return;

  const term = leaseSummaryCache?.find(t => t.id === termId);
  if (!term) return;

  btn.disabled = true;
  btn.textContent = '…';
  responseEl.style.display = 'none';

  try {
    // Include relevant section text for better context
    let sectionContext = '';
    if (viewerSectionsCache && term.source_sections?.length > 0) {
      const relevantTexts = term.source_sections
        .map(i => viewerSectionsCache[i])
        .filter(Boolean)
        .map(s => `[${s.heading}]: ${s.text.substring(0, 800)}`)
        .join('\n\n');
      sectionContext = `\n\nRELEVANT LEASE SECTIONS:\n${relevantTexts}`;
    }

    const prompt = `
A renter is reviewing their lease. They are looking at this clause:

Term: ${term.label}
Value: ${term.value}
Full context: ${term.explanation}
Regulation note: ${term.citation}
${sectionContext}

Their question: "${question}"

Answer in 2-4 sentences. Be specific and grounded in the lease details above.
Do not give legal advice — explain and inform. If uncertain, say so clearly.
    `.trim();

    const answer = await callGemini(prompt);
    responseEl.textContent = answer;
    responseEl.style.display = 'block';
    input.value = '';
  } catch (err) {
    responseEl.textContent = 'Error: ' + err.message;
    responseEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
  }
}

// Correction Handler
function handleCorrection(termId) {
  const corrected = prompt('What should this say? Enter the correct information:');
  if (!corrected) return;

  const term = leaseSummaryCache?.find(t => t.id === termId);
  if (term) {
    term.value = corrected;
    term.explanation = `[Corrected by user] ${corrected}`;
    renderTerms(leaseSummaryCache);
    alert('Updated! The corrected value is now shown.');
  }
}

// Priority Tag Selection
const selectedTags = new Set();
document.querySelectorAll('.priority-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const val = tag.dataset.tag;
    if (selectedTags.has(val)) {
      selectedTags.delete(val);
      tag.classList.remove('selected');
    } else {
      selectedTags.add(val);
      tag.classList.add('selected');
    }
  });
});

// Persist priority concerns across sessions
function savePriorityConcerns() {
  chrome.storage.local.set({
    savedTags: [...selectedTags],
    savedFreeText: priorityFreeText.value
  });
}

function loadPriorityConcerns() {
  chrome.storage.local.get(['savedTags', 'savedFreeText'], (result) => {
    if (result.savedTags) {
      result.savedTags.forEach(tag => selectedTags.add(tag));
      document.querySelectorAll('.priority-tag').forEach(el => {
        if (selectedTags.has(el.dataset.tag)) {
          el.classList.add('selected');
        }
      });
    }
    if (result.savedFreeText) {
      priorityFreeText.value = result.savedFreeText;
    }
  });
}

// Task 2 Prompt
function buildPriorityPrompt(summary, selectedTags, freeText) {
  return `
You are helping a renter understand which parts of their lease are most relevant to their personal situation.

LEASE SUMMARY (already extracted):
${JSON.stringify(summary, null, 2)}

USER'S STATED PRIORITIES:
- Selected tags: ${selectedTags.join(', ') || 'none'}
- In their own words: "${freeText || 'not specified'}"

Return ONLY valid JSON — no markdown, no explanation outside the JSON.

{
  "focused_terms": [
    {
      "label": "Term name",
      "lease_says": "What the lease actually says about this (quote or paraphrase)",
      "relevant_because": "1-2 sentence explanation of why this is relevant to what the user said",
      "severity": "ok|caution|alert",
      "action": "Specific thing the user should do or ask before signing (1 sentence)"
    }
  ]
}

Include only terms that are directly relevant to the user's priorities.
Order by severity: alert first, then caution, then ok.
If the lease doesn't mention something the user cares about, include it with severity "caution" and explain that it's undisclosed.
`.trim();
}

// Personalized Submit button
prioritySubmitBtn.addEventListener('click', async () => {
  if (!leaseSummaryCache) return;
  const freeText = priorityFreeText.value.trim();
  if (selectedTags.size === 0 && !freeText) {
    alert('Please select at least one priority or describe what matters to you.');
    return;
  }

  prioritySubmitBtn.disabled = true;
  prioritySubmitBtn.textContent = 'Analyzing…';
  savePriorityConcerns();

  try {
    const prompt = buildPriorityPrompt(leaseSummaryCache, [...selectedTags], freeText);
    const raw = await callGemini(prompt);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
      if (match) parsed = JSON.parse(match[1]);
      else throw new Error('Could not parse AI response as JSON');
    }
    renderPriorityCards(parsed.focused_terms);
    priorityResults.style.display = 'block';
    priorityResults.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert('Error re-focusing: ' + err.message);
  } finally {
    prioritySubmitBtn.disabled = false;
    prioritySubmitBtn.textContent = 'Re-focus analysis for me';
  }
});

// Render Priority Cards
function renderPriorityCards(focusedTerms) {
  priorityCardsList.innerHTML = '';
  focusedTerms.forEach(item => {
    const card = document.createElement('div');
    card.className = 'focused-card';

    const relevanceClass = {
      ok: 'relevance-ok',
      caution: 'relevance-warning',
      alert: 'relevance-alert'
    }[item.severity] || 'relevance-ok';

    const icon = { ok: '✓', caution: '⚠', alert: '✕' }[item.severity] || '';

    card.innerHTML = `
      <div class="focused-header">
        <div class="focused-title">${icon} ${item.label}</div>
        <div class="focused-lease-text">"${item.lease_says}"</div>
        <div class="focused-relevance ${relevanceClass}">${item.relevant_because}</div>
      </div>
      <div style="padding: 10px 14px; font-size: 12px; color: #9aacbc; border-top: 1px solid var(--border)">
        <strong style="color: var(--gold);">Action:</strong> ${item.action}
      </div>
    `;
    priorityCardsList.appendChild(card);
  });
}

// ── Main Analysis Pipeline ──

async function runAnalysis() {
  showState('Loading');

  try {
    // Step 1: Load regulations
    setLoadingStep('Loading regulations…');
    const regulations = await loadRegulations();

    // Step 2: Fetch PDF
    setLoadingStep('Fetching PDF…');
    const pdfBase64 = await getPDFBase64();

    // Step 3: Extract text from PDF using pdf.js
    setLoadingStep('Extracting text from PDF…');
    const pages = await extractPDFText(pdfBase64);

    // Step 4: Split into sections
    setLoadingStep('Splitting into sections…');
    const sections = splitIntoSections(pages);

    // Step 5: Pass 1 — Filter which sections are relevant per term
    setLoadingStep('Filtering relevant sections…');
    const filterPrompt = buildFilterPrompt(sections);
    const filterRaw = await callGemini(filterPrompt, null, FILTER_SCHEMA);
    const filterResult = JSON.parse(filterRaw);

    // Build a map: termId → [section objects]
    const termSectionMap = {};
    for (const termId of TERM_IDS) {
      termSectionMap[termId] = [];
    }
    for (const mapping of filterResult.section_mappings) {
      const section = sections[mapping.section_index];
      if (!section) continue;
      for (const termId of mapping.relevant_terms) {
        if (termSectionMap[termId]) {
          termSectionMap[termId].push(section);
        }
      }
    }

    // Step 6: Pass 2 — Analyze each term with its relevant sections
    setLoadingStep('Analyzing lease terms…');

    const termLabels = {
      security_deposit: 'Security Deposit',
      monthly_rent: 'Monthly Rent',
      lease_term: 'Lease Term',
      late_fee: 'Late Fee',
      early_termination: 'Early Termination',
      pet_policy: 'Pet Policy',
      landlord_entry: 'Landlord Entry',
      utilities: 'Utilities',
      parking: 'Parking',
      rent_increase: 'Rent Increase',
      subletting: 'Subletting'
    };

    // Build a single combined analysis prompt for all terms (more efficient than per-term calls)
    const allTermSections = TERM_IDS.map(termId => {
      const relevantSections = termSectionMap[termId];
      const sectionTexts = relevantSections.length > 0
        ? relevantSections.map(s =>
            `[Section ${s.index}: "${s.heading}" (pages ${s.startPage}-${s.endPage})]\n${s.text}`
          ).join('\n\n')
        : 'No relevant sections found in the lease.';
      return `--- TERM: ${termLabels[termId]} (id: ${termId}) ---\nRelevant sections:\n${sectionTexts}`;
    }).join('\n\n=====\n\n');

    const regText = regulations.pages
      ? regulations.pages.map(p => p.text).join('\n')
      : JSON.stringify(regulations, null, 2);

    const analysisPrompt = `
You are analyzing a residential lease document. For each term below, you have been given only the relevant sections of the lease.

LEASE SECTIONS BY TERM:
${allTermSections}

SEATTLE REGULATIONS REFERENCE:
${regText}

For each of the following term IDs, provide a complete analysis:
${TERM_IDS.join(', ')}

For each term:
- Extract the value from the lease sections
- Assess the risk level (low, medium, high, or unknown if not found)
- Explain in plain language why the risk level was assigned (2-3 sentences)
- Cite any applicable Seattle regulation
- Note how it compares to typical Seattle market rates
- List the source_sections indices you relied on
- Quote the most relevant text from the lease (quoted_text)

If a term is not found in its sections, set value to "Not found" and risk to "unknown".
`.trim();

    const analysisRaw = await callGemini(analysisPrompt, null, ANALYSIS_SCHEMA);
    const analysisResult = JSON.parse(analysisRaw);

    // Store results
    leaseSummaryCache = analysisResult.terms;
    viewerSectionsCache = sections;

    renderTerms(analysisResult.terms);

    // Store term data and sections for the full-document viewer
    chrome.storage.local.set({
      viewerTerms: analysisResult.terms,
      viewerSections: sections
    });

    // Insert "View Full Document" button above the terms list
    const existingBtn = document.querySelector('.view-doc-btn');
    if (!existingBtn) {
      const btn = document.createElement('button');
      btn.className = 'view-doc-btn';
      btn.textContent = '📄 View Full Document with Highlights';
      btn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
      });
      termsList.parentNode.insertBefore(btn, termsList);
    }

    showState('Results');
    loadPriorityConcerns();

  } catch (err) {
    stateLoading.classList.remove('active');
    stateIdle.classList.add('active');
    document.querySelector('.idle-title').textContent = 'Analysis failed';
    document.querySelector('.idle-sub').textContent = err.message;
  }
}

// Fetch the actual PDF from the page URL via background worker
function getPDFBase64() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['pdfURL'], ({ pdfURL }) => {
      if (!pdfURL) {
        reject(new Error('No PDF URL found. Click "Analyze This Lease" in the extension popup on a PDF page.'));
        return;
      }
      fetchPDFBase64(pdfURL).then(resolve).catch(reject);
    });
  });
}

// Kick everything off
runAnalysis();
showState('Loading');
