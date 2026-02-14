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

// Call Gemini via the background service worker (optional pdfBase64 for inline PDF)
function callGemini(prompt, pdfBase64) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
      if (!apiKey) { reject(new Error('No API key')); return; }
      chrome.runtime.sendMessage(
        { action: 'callGemini', prompt, apiKey, pdfBase64 },
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

// Task 1 Prompt (PDF is sent inline, so no need to embed lease text)
function buildSummaryPrompt(regulations) {
  return `
You are analyzing the attached residential lease PDF. Read the entire document carefully.
Extract and evaluate the following key terms from what you find in the PDF.
Return ONLY valid JSON — no markdown, no explanation outside the JSON.

SEATTLE REGULATIONS REFERENCE:
${JSON.stringify(regulations.regulations, null, 2)}

Return this exact JSON structure:
{
  "terms": [
    {
      "id": "security_deposit",
      "label": "Security Deposit",
      "value": "extracted value or 'Not found'",
      "risk": "low|medium|high|unknown",
      "explanation": "Plain language explanation of this term and why the risk level was assigned (2-3 sentences)",
      "citation": "Relevant regulation or 'No specific regulation applies'",
      "market_note": "How this compares to typical Seattle market rates"
    }
  ]
}

Include these term IDs: security_deposit, monthly_rent, lease_term, late_fee, early_termination, pet_policy, landlord_entry, utilities, parking, rent_increase, subletting.
If a term is not found in the lease, set value to "Not found" and risk to "unknown".
`.trim();
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

// Render Term Cards
function renderTerms(terms) {
  termsList.innerHTML = '';
  terms.forEach(term => {
    const card = document.createElement('div');
    card.className = `term-card risk-${term.risk}`;
    card.dataset.id = term.id;

    const riskLabel = { low: 'Standard', medium: 'Review', high: 'Flagged', unknown: 'Not found' }[term.risk] || '';
    const badgeClass = { low: 'badge-green', medium: 'badge-yellow', high: 'badge-red', unknown: 'badge-gray' }[term.risk] || 'badge-gray';

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
    const prompt = `
A renter is reviewing their lease. They are looking at this clause:

Term: ${term.label}
Value: ${term.value}
Full context: ${term.explanation}
Regulation note: ${term.citation}

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

  try {
    const prompt = buildPriorityPrompt(leaseSummaryCache, [...selectedTags], freeText);
    const raw = await callGemini(prompt);
    
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try to pull JSON out of a markdown code block if Gemini wraps it
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

// Run Analysis on Load
async function runAnalysis() {
  showState('Loading');
  setLoadingStep('Loading regulations…');

  try {
    const regulations = await loadRegulations();

    setLoadingStep('Fetching PDF…');
    const pdfBase64 = await getPDFBase64();

    setLoadingStep('Analyzing with AI…');
    const prompt = buildSummaryPrompt(regulations);
    const raw = await callGemini(prompt, pdfBase64);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try to pull JSON out of a markdown code block if Gemini wraps it
      const match = raw.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
      if (match) parsed = JSON.parse(match[1]);
      else throw new Error('Could not parse AI response as JSON');
    }

    leaseSummaryCache = parsed.terms;
    renderTerms(parsed.terms);
    showState('Results');

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
        reject(new Error('No PDF URL found. Click "Analyze This Lease" from the popup on a PDF page.'));
        return;
      }
      fetchPDFBase64(pdfURL).then(resolve).catch(reject);
    });
  });
}

// Kick everything off
runAnalysis();
showState('Loading');