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
      "market_note": "How this compares to typical Seattle market rates",
      "source_text": "The exact verbatim phrase (10-25 words) from the document that supports this value. Empty string if not found.",
      "source_page": "Page number (integer) where this term appears in the document. 0 if not found."
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
        ${term.source_text ? `
        <div class="source-quote">
          <span class="source-quote-label">Found on page ${term.source_page || '?'}:</span>
          <span class="source-quote-text">"${term.source_text}"</span>
        </div>` : ''}
        <div class="term-actions-row">
          ${term.source_text ? `<button class="jump-btn" data-term-id="${term.id}">↗ Jump to page ${term.source_page || '?'}</button>` : ''}
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

  // Jump to source handlers
  document.querySelectorAll('.jump-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const term = leaseSummaryCache?.find(t => t.id === btn.dataset.termId);
      if (term) handleJump(term.source_text, term.source_page);
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

// Jump to Source Handler
function handleJump(sourceText, sourcePage) {
  if (!sourcePage || sourcePage <= 0) return;
  window.parent.postMessage({ action: 'snJumpToPage', page: sourcePage, text: sourceText }, '*');
}

// Correction Handler
function handleCorrection(termId) {
  const card = document.querySelector(`.term-card[data-id="${termId}"]`);
  if (!card) return;
  const term = leaseSummaryCache?.find(t => t.id === termId);
  if (!term) return;

  const correctRow = card.querySelector('.correct-row');
  if (correctRow.querySelector('.correct-form')) return; // already open

  correctRow.innerHTML = `
    <div class="correct-form">
      <div class="correct-current">Current value: <span class="correct-current-val">${term.value}</span></div>
      <input class="correct-input" type="text" placeholder="Enter the correct value…" />
      <div class="correct-actions">
        <button class="correct-verify-btn">Verify &amp; Apply</button>
        <button class="correct-cancel-btn">Cancel</button>
      </div>
      <div class="correct-verify-result"></div>
    </div>
  `;

  const input = correctRow.querySelector('.correct-input');
  const verifyBtn = correctRow.querySelector('.correct-verify-btn');
  const cancelBtn = correctRow.querySelector('.correct-cancel-btn');
  const resultEl = correctRow.querySelector('.correct-verify-result');

  function restoreButton() {
    correctRow.innerHTML = `<button class="correct-btn" data-term-id="${termId}">✎ This looks wrong</button>`;
    correctRow.querySelector('.correct-btn').addEventListener('click', () => handleCorrection(termId));
  }

  function applyCorrection(newValue) {
    term.value = newValue;
    term.explanation = `[User corrected] ${newValue}`;
    renderTerms(leaseSummaryCache);
    const newCard = document.querySelector(`.term-card[data-id="${termId}"]`);
    if (newCard) newCard.classList.add('open');
  }

  cancelBtn.addEventListener('click', restoreButton);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyBtn.click();
  });

  verifyBtn.addEventListener('click', async () => {
    const newValue = input.value.trim();
    if (!newValue) return;

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
    resultEl.style.display = 'none';

    try {
      const verifyPrompt = `
You are a fact-checker for a lease analysis tool. Your job is to defend what the lease document actually states.

The AI read the lease and extracted this:
Term: ${term.label}
Extracted value: "${term.value}"
Evidence from the lease: ${term.explanation}

A user is disputing this and claims the correct value is: "${newValue}"

Does the user's value match what the lease document actually states, or does it contradict the extracted evidence?
- If the extracted value is supported by the lease evidence, say so and note that the original appears correct.
- Only favor the user's value if their input is clearly more consistent with the lease evidence than what was extracted.
- Do NOT justify the user's input as "plausible in general" — you must evaluate it against the specific lease evidence above.

Reply in this exact JSON format (no markdown):
{"verdict":"original_correct"|"user_correct"|"uncertain","reason":"one sentence referencing the specific values and lease evidence"}
      `.trim();

      const raw = await callGemini(verifyPrompt);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
        if (match) parsed = JSON.parse(match[1]);
        else throw new Error('Could not parse verification response');
      }

      const { verdict, reason } = parsed;
      const isWarn = verdict === 'original_correct';
      const applyLabel = isWarn ? 'Apply anyway' : 'Apply correction';
      const verdictClass = verdict === 'user_correct' ? 'verdict-ok' : isWarn ? 'verdict-warn' : 'verdict-uncertain';
      const verdictIcon = verdict === 'user_correct' ? '✓' : isWarn ? '⚠' : '?';

      resultEl.className = `correct-verify-result ${verdictClass}`;
      resultEl.innerHTML = `
        ${verdictIcon} <span class="correct-reason">${reason}</span>
        <div class="correct-confirm-row">
          <button class="correct-apply-btn">${applyLabel}</button>
          <button class="correct-cancel-inline-btn">Cancel</button>
        </div>
      `;
      resultEl.style.display = 'block';

      resultEl.querySelector('.correct-apply-btn').addEventListener('click', () => applyCorrection(newValue));
      resultEl.querySelector('.correct-cancel-inline-btn').addEventListener('click', restoreButton);

    } catch (err) {
      resultEl.className = 'correct-verify-result verdict-uncertain';
      resultEl.innerHTML = `
        Could not verify: ${err.message}
        <div class="correct-confirm-row">
          <button class="correct-apply-btn">Apply anyway</button>
          <button class="correct-cancel-inline-btn">Cancel</button>
        </div>
      `;
      resultEl.style.display = 'block';

      resultEl.querySelector('.correct-apply-btn').addEventListener('click', () => applyCorrection(input.value.trim()));
      resultEl.querySelector('.correct-cancel-inline-btn').addEventListener('click', restoreButton);
    } finally {
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify & Apply';
    }
  });
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
    const parsed = JSON.parse(raw);
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