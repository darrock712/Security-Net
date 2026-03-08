// Handles Task 1 (summarize and review) and Task 2 (custom topics / memories)

// Grab all the elements we need
const stateIdle    = document.getElementById('stateIdle');
const stateLoading = document.getElementById('stateLoading');
const stateResults = document.getElementById('stateResults');
const loadingStep  = document.getElementById('loadingStep');
const termsList    = document.getElementById('termsList');
const priorityFreeText  = document.getElementById('priorityFreeText');
const priorityAddBtn    = document.getElementById('priorityAddBtn');
const memoriesSection   = document.getElementById('memoriesSection');
const memoriesList      = document.getElementById('memoriesList');
const memoriesToggle    = document.getElementById('memoriesToggle');

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

// Helper: parse JSON from Gemini response (handles markdown code blocks, control chars, truncation)
function parseGeminiJSON(raw) {
  // Step 1: Extract from markdown code block if present
  let jsonStr = raw;
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }
  
  // Step 2: Try to find JSON object/array boundaries
  const startIdx = jsonStr.search(/[\[{]/);
  if (startIdx === -1) throw new Error('No JSON found in response');
  jsonStr = jsonStr.slice(startIdx);
  
  // Step 3: Remove control characters that break JSON
  jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === '\n' || c === '\r' || c === '\t') return c;
    return '';
  });
  
  // Step 4: Try parsing as-is
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Step 5: Try to fix common issues - truncated JSON
    // Find the last complete object/array
    let depth = 0;
    let lastValidEnd = -1;
    let inString = false;
    let escaped = false;
    
    for (let i = 0; i < jsonStr.length; i++) {
      const c = jsonStr[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) lastValidEnd = i;
      }
    }
    
    if (lastValidEnd > 0) {
      try {
        return JSON.parse(jsonStr.slice(0, lastValidEnd + 1));
      } catch {}
    }
    
    // Step 6: Try adding closing brackets
    let fixedJson = jsonStr;
    while (depth > 0) {
      // Guess what's needed based on last opener
      const lastOpen = jsonStr.lastIndexOf('{') > jsonStr.lastIndexOf('[') ? '}' : ']';
      fixedJson += lastOpen;
      depth--;
    }
    
    try {
      return JSON.parse(fixedJson);
    } catch {
      throw new Error('Could not parse AI response as JSON: ' + e.message);
    }
  }
}

// Load saved custom categories from storage
function loadCustomCategories() {
  return new Promise(resolve => {
    chrome.storage.local.get(['customCategories'], ({ customCategories }) => {
      resolve(customCategories || []);
    });
  });
}

// Save a new custom category
function saveCustomCategory(category) {
  return new Promise(resolve => {
    chrome.storage.local.get(['customCategories'], ({ customCategories }) => {
      const existing = customCategories || [];
      if (!existing.includes(category)) {
        existing.push(category);
        chrome.storage.local.set({ customCategories: existing }, resolve);
      } else {
        resolve();
      }
    });
  });
}

// Remove a custom category
function removeCustomCategory(category) {
  return new Promise(resolve => {
    chrome.storage.local.get(['customCategories'], ({ customCategories }) => {
      const updated = (customCategories || []).filter(c => c !== category);
      chrome.storage.local.set({ customCategories: updated }, resolve);
    });
  });
}

// Save a subtopic question linked to a parent term
function saveSubtopic(parentId, question) {
  return new Promise(resolve => {
    chrome.storage.local.get(['savedSubtopics'], ({ savedSubtopics }) => {
      const existing = savedSubtopics || [];
      const alreadySaved = existing.some(s => s.parentId === parentId && s.question === question);
      if (!alreadySaved) {
        existing.push({ parentId, question });
        chrome.storage.local.set({ savedSubtopics: existing }, resolve);
      } else {
        resolve();
      }
    });
  });
}

// Load all saved subtopics
function loadSavedSubtopics() {
  return new Promise(resolve => {
    chrome.storage.local.get(['savedSubtopics'], ({ savedSubtopics }) => {
      resolve(savedSubtopics || []);
    });
  });
}

// Remove a saved subtopic
function removeSavedSubtopic(parentId, question) {
  return new Promise(resolve => {
    chrome.storage.local.get(['savedSubtopics'], ({ savedSubtopics }) => {
      const updated = (savedSubtopics || []).filter(
        s => !(s.parentId === parentId && s.question === question)
      );
      chrome.storage.local.set({ savedSubtopics: updated }, resolve);
    });
  });
}



// Use AI to normalize user input into a clean category name
async function normalizeCategoryName(userInput) {
  const prompt = `
A user wants to add a custom category to analyze in their lease.

User input: "${userInput}"

Convert this into a short, clear category label (2-4 words max).
Examples:
- "I have a large dog" → "Large Pet Policy"
- "what if I need to leave early" → "Early Termination"
- "smoking on balcony" → "Smoking Policy"
- "can my partner move in" → "Occupancy Rules"
- "noise after 10pm" → "Noise Policy"

Return ONLY the category label, nothing else. No quotes, no explanation.
`.trim();

  const result = await callGemini(prompt);
  return result.trim().replace(/["']/g, '');
}

// Task 1 Prompt (PDF is sent inline, so no need to embed lease text)
function buildSummaryPrompt(regulations) {
  // Extract just the relevant regulation text, not the full pages array
  const regContext = regulations.pages 
    ? regulations.pages.map(p => p.text).join('\n').slice(0, 8000)  // Limit size
    : JSON.stringify(regulations).slice(0, 8000);
  
  return `
You are analyzing the attached residential lease PDF. Read the entire document carefully.
Extract and evaluate the following key terms from what you find in the PDF.

IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, no explanation outside the JSON.
Escape all special characters in strings (quotes, newlines, backslashes).

SEATTLE RENTER REGULATIONS CONTEXT (for reference when assessing risk):
${regContext}

Return this exact JSON structure:
{
  "terms": [
    {
      "id": "security_deposit",
      "label": "Security Deposit",
      "value": "extracted value or Not found",
      "risk": "low|medium|high|unknown",
      "explanation": "Plain language explanation (2-3 sentences). Wrap key lease terms or values in [[ ]] like [[one cat allowed under 20 lbs]] or [[$300 pet deposit]] so they can be linked to the source.",
      "citation": "Relevant regulation code or No specific regulation",
      "market_note": "How this compares to typical Seattle market rates",
      "source_text": "Brief verbatim phrase (10-25 words) from document, or empty string",
      "source_page": 0
    }
  ]
}

Include these term IDs: security_deposit, monthly_rent, lease_term, late_fee, early_termination, pet_policy, landlord_entry, utilities, parking, rent_increase, subletting.
If a term is not found in the lease, set value to "Not found" and risk to "unknown".
Keep all string values simple - avoid special characters, quotes within quotes, or line breaks.
`.trim();
}

// Render Term Cards
function renderTerms(terms) {
  termsList.innerHTML = '';
  terms.forEach(term => {
    const card = document.createElement('div');
    card.className = `term-card risk-${term.risk}${term.isSubtopic ? ' subtopic-card' : ''}`;
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
          ${term.isSubtopic ? `<button class="subtopic-delete" data-term-id="${term.id}">×</button>` : `<span class="expand-arrow">▼</span>`}
        </div>
      </div>
      <div class="term-body">
        <div class="term-explanation ${term.source_text ? 'has-source' : ''}"
            data-term-id="${term.id}"
            title="${term.source_text ? 'Click to highlight in lease' : ''}">
          ${term.source_text
            ? term.explanation.replace(/\[\[(.+?)\]\]/g, (_, phrase) =>
                `<span class="highlight-phrase" data-phrase="${phrase}" data-term-id="${term.id}">${phrase}</span>`)
            : term.explanation}
          ${term.source_text ? `<span class="source-hint">📄 pg. ${term.source_page || '?'}</span>` : ''}
        </div>
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
          <label style="display:flex;align-items:center;gap:6px;margin-top:7px;cursor:pointer;">
            <input type="checkbox" class="save-subq-checkbox" data-term-id="${term.id}" style="accent-color:var(--gold);cursor:pointer;">
            <span style="font-size:11px;color:var(--muted);">Save as subtopic under ${term.label}</span>
          </label>
          <div class="followup-response" id="followup-${term.id}"></div>
        </div>
          <div class="term-actions-row">
            <button class="correct-btn" data-term-id="${term.id}">✎ This looks wrong</button>
          </div>
          <div class="correct-row"></div>
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

  // Clicking the whole explanation still jumps to the page
  document.querySelectorAll('.term-explanation.has-source').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't double-fire if a phrase span was clicked
      if (e.target.classList.contains('highlight-phrase')) return;
      const term = leaseSummaryCache?.find(t => t.id === el.dataset.termId);
      if (term) handleJump(term.source_text, term.source_page);
    });
  });

  // Clicking a specific phrase jumps + searches that exact phrase
  document.querySelectorAll('.highlight-phrase').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      const term = leaseSummaryCache?.find(t => t.id === span.dataset.termId);
      if (term) handleJump(span.dataset.phrase, term.source_page);
    });
  });

  // Correction handlers
  document.querySelectorAll('.correct-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCorrection(btn.dataset.termId));
  });
}
  // Delete subtopic handlers
  document.querySelectorAll('.subtopic-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const termId = btn.dataset.termId;
      const term = leaseSummaryCache?.find(t => t.id === termId);
      if (term?.savedQuestion && term?.parentId) {
        await removeSavedSubtopic(term.parentId, term.savedQuestion);
        await renderMemories();
      }
      leaseSummaryCache = leaseSummaryCache.filter(t => t.id !== termId);
      renderTerms(leaseSummaryCache);
    });
  });

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

    // Save as sub-topic if checkbox is checked
    const saveCheckbox = document.querySelector(`.save-subq-checkbox[data-term-id="${termId}"]`);
    const shouldSave = saveCheckbox && saveCheckbox.checked;

    const subId = `${termId}_sub_${Date.now()}`;
    const subTerm = {
      id: subId,
      label: question,
      value: '',
      risk: term.risk,
      explanation: answer,
      citation: term.citation,
      market_note: '',
      source_text: '',
      source_page: term.source_page,
      parentId: termId,
      isSubtopic: true,
      savedQuestion: shouldSave ? question : null
    };

    const parentIdx = leaseSummaryCache.findIndex(t => t.id === termId);
    leaseSummaryCache.splice(parentIdx + 1, 0, subTerm);
    renderTerms(leaseSummaryCache);

    const parentCard = document.querySelector(`.term-card[data-id="${termId}"]`);
    if (parentCard) parentCard.classList.add('open');
    const subCard = document.querySelector(`.term-card[data-id="${subId}"]`);
    if (subCard) {
      subCard.classList.add('just-added');
      subCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => subCard.classList.remove('just-added'), 2000);
    }

    if (shouldSave) {
      await saveSubtopic(termId, question);
      await renderMemories();
      saveCheckbox.checked = false;
    }
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
async function handleCorrection(termId) {
  const card = document.querySelector(`.term-card[data-id="${termId}"]`);
  if (!card) return;
  const term = leaseSummaryCache?.find(t => t.id === termId);
  if (!term) return;

  const correctRow = card.querySelector('.correct-row');
  if (correctRow.querySelector('.correct-form')) return;

  // Show loading state immediately
  correctRow.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:6px 0;">Finding alternatives…</div>`;

  // Ask AI for alternative readings
  let alternatives = [];
  try {
    const altPrompt = `
You analyzed a lease and extracted this value for "${term.label}": "${term.value}"
Your explanation was: "${term.explanation}"

The user thinks this might be wrong. Generate 3 alternative interpretations of what this clause could mean or say.
Keep each under 10 words. Be specific and realistic for a residential lease.

Return ONLY a JSON array of 3 strings, no markdown:
["alternative 1", "alternative 2", "alternative 3"]
    `.trim();

    const raw = await callGemini(altPrompt);
    alternatives = parseGeminiJSON(raw);
  } catch {
    alternatives = [];
  }

  // Build the choices UI
  const choicesHTML = alternatives.length > 0 ? `
    <div class="correct-choices-label">Did you mean one of these?</div>
    <div class="correct-choices">
      ${alternatives.map((alt, i) => `
        <button class="correct-choice-btn" data-index="${i}">${alt}</button>
      `).join('')}
    </div>
    <div class="correct-divider-label">Or enter your own:</div>
  ` : '';

  correctRow.innerHTML = `
    <div class="correct-form">
      <div class="correct-current">Current: <span class="correct-current-val">${term.value}</span></div>
      ${choicesHTML}
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

  // Clicking a choice pre-fills the input and highlights the button
  correctRow.querySelectorAll('.correct-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.textContent;
      correctRow.querySelectorAll('.correct-choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      input.focus();
    });
  });

  function restoreButton() {
    correctRow.innerHTML = `<button class="correct-btn" data-term-id="${termId}">✎ This looks wrong</button>`;
    correctRow.querySelector('.correct-btn').addEventListener('click', () => handleCorrection(termId));
  }

  function applyCorrection(newValue) {
    term.value = newValue;
    term.explanation = `[Corrected by user] ${newValue}`;
    renderTerms(leaseSummaryCache);
    const newCard = document.querySelector(`.term-card[data-id="${termId}"]`);
    if (newCard) newCard.classList.add('open');
  }

  cancelBtn.addEventListener('click', restoreButton);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyBtn.click(); });

  verifyBtn.addEventListener('click', async () => {
    const newValue = input.value.trim();
    if (!newValue) return;

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
    resultEl.style.display = 'none';

    try {
      const verifyPrompt = `
You are a fact-checker for a lease analysis tool.

Term: ${term.label}
Extracted value: "${term.value}"
Evidence: ${term.explanation}
User's proposed value: "${newValue}"

Does the user's value match the lease evidence better than what was extracted?
Reply ONLY as JSON (no markdown):
{"verdict":"original_correct"|"user_correct"|"uncertain","reason":"one sentence"}
      `.trim();

      const raw = await callGemini(verifyPrompt);
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch {
        const match = raw.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
        if (match) parsed = JSON.parse(match[1]);
        else throw new Error('Could not parse verification response');
      }

      const { verdict, reason } = parsed;
      const isWarn = verdict === 'original_correct';
      const verdictClass = verdict === 'user_correct' ? 'verdict-ok' : isWarn ? 'verdict-warn' : 'verdict-uncertain';
      const verdictIcon = verdict === 'user_correct' ? '✓' : isWarn ? '⚠' : '?';

      resultEl.className = `correct-verify-result ${verdictClass}`;
      resultEl.innerHTML = `
        ${verdictIcon} <span class="correct-reason">${reason}</span>
        <div class="correct-confirm-row">
          <button class="correct-apply-btn">${isWarn ? 'Apply anyway' : 'Apply correction'}</button>
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

// Memories toggle
memoriesToggle.addEventListener('click', () => {
  memoriesSection.classList.toggle('open');
});
document.querySelector('.memories-header').addEventListener('click', () => {
  memoriesSection.classList.toggle('open');
});

// Render the memories list
async function renderMemories() {
  const categories = await loadCustomCategories();
  
  if (categories.length === 0) {
    memoriesSection.style.display = 'none';
    return;
  }
  
  memoriesSection.style.display = 'block';
  memoriesList.innerHTML = '';
  
  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'memory-item';
    item.innerHTML = `
      <span class="memory-name">${cat}</span>
      <button class="memory-delete" data-category="${cat}">×</button>
    `;
    memoriesList.appendChild(item);
  });

  const subtopics = await loadSavedSubtopics();
  if (subtopics.length > 0) {
    const subHeader = document.createElement('div');
    subHeader.style.cssText = 'font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;';
    subHeader.textContent = 'Saved Follow-ups';
    memoriesList.appendChild(subHeader);

    subtopics.forEach(sub => {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.innerHTML = `
        <div>
          <div class="memory-name">${sub.question}</div>
          <div style="font-size:10px;color:var(--muted);">under ${sub.parentId.replace(/_/g,' ')}</div>
        </div>
        <button class="memory-delete" data-parent-id="${sub.parentId}" data-question="${sub.question}">×</button>
      `;
      memoriesList.appendChild(item);
    });

    memoriesList.querySelectorAll('.memory-delete[data-question]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const parentId = btn.dataset.parentId;
        const question = btn.dataset.question;
        await removeSavedSubtopic(parentId, question);

        // Also remove from current session if it exists
        if (leaseSummaryCache) {
          leaseSummaryCache = leaseSummaryCache.filter(t =>
            !(t.isSubtopic && t.parentId === parentId && t.savedQuestion === question)
          );
          renderTerms(leaseSummaryCache);
        }

        await renderMemories();
      });
    });
  }
  
  // Setup delete handlers
  memoriesList.querySelectorAll('.memory-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const category = btn.dataset.category;
      await removeCustomCategory(category);
      
      // Remove from current analysis if present
      if (leaseSummaryCache) {
        const id = category.toLowerCase().replace(/\s+/g, '_');
        leaseSummaryCache = leaseSummaryCache.filter(t => t.id !== id);
        renderTerms(leaseSummaryCache);
      }
      
      renderMemories();
    });
  });
}

// Add Category Button handler
priorityAddBtn.addEventListener('click', async () => {
  const userInput = priorityFreeText.value.trim();
  if (!userInput) return;
  
  priorityAddBtn.disabled = true;
  priorityAddBtn.textContent = '...';
  
  try {
    // Normalize the category name using AI
    const normalizedName = await normalizeCategoryName(userInput);
    
    // Check if already saved
    const existing = await loadCustomCategories();
    if (existing.some(c => c.toLowerCase() === normalizedName.toLowerCase())) {
      alert(`"${normalizedName}" is already saved.`);
      priorityFreeText.value = '';
      return;
    }
    
    // Save the new category
    await saveCustomCategory(normalizedName);
    
    // Analyze immediately for current lease if we have it
    if (leaseSummaryCache) {
      await analyzeCustomCategory(normalizedName);
    }
    
    // Update memories display
    renderMemories();
    
    priorityFreeText.value = '';
  } catch (err) {
    console.error('Error adding category:', err);
    alert('Error adding topic: ' + err.message);
  } finally {
    priorityAddBtn.disabled = false;
    priorityAddBtn.textContent = '+ Add';
  }
});

// Enter key in input triggers Add
priorityFreeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    priorityAddBtn.click();
  }
});

// Analyze a custom category and add it as a new term card
async function analyzeCustomCategory(category) {
  const pdfBase64 = await getPDFBase64();
  
  const prompt = `
You are analyzing the attached residential lease PDF for a specific topic the user cares about.

TOPIC TO ANALYZE: "${category}"

Return ONLY valid JSON - no markdown, no code blocks, no explanation outside the JSON.

{
  "id": "${category.toLowerCase().replace(/\s+/g, '_')}",
  "label": "${category}",
  "value": "What the lease says about this topic, or Not found if not mentioned",
  "risk": "low|medium|high|unknown",
  "explanation": "Plain language explanation (2-3 sentences)",
  "citation": "Relevant regulation or No specific regulation",
  "market_note": "How this compares to typical Seattle rentals",
  "source_text": "Brief verbatim phrase from document or empty string",
  "source_page": 0
}

If the lease does not mention this topic at all, set value to "Not found" and risk to "unknown".
Keep all string values simple - no special characters or quotes within quotes.
`.trim();

  const raw = await callGemini(prompt, pdfBase64);
  const newTerm = parseGeminiJSON(raw);
  
  // Add to cache and re-render (avoid duplicates)
  const existingIndex = leaseSummaryCache.findIndex(t => t.id === newTerm.id);
  if (existingIndex >= 0) {
    leaseSummaryCache[existingIndex] = newTerm;
  } else {
    leaseSummaryCache.push(newTerm);
  }
  renderTerms(leaseSummaryCache);
  
  // Scroll to and highlight the new card
  const newCard = document.querySelector(`.term-card[data-id="${newTerm.id}"]`);
  if (newCard) {
    newCard.classList.add('open', 'just-added');
    newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => newCard.classList.remove('just-added'), 2000);
  }
}

async function analyzeSubtopic(parentId, question) {
  const parent = leaseSummaryCache?.find(t => t.id === parentId);
  if (!parent) return;

  const pdfBase64 = await getPDFBase64();
  const prompt = `
You are analyzing a residential lease PDF for a specific follow-up question about a clause.

Parent clause: ${parent.label}
Parent value: ${parent.value}
Parent explanation: ${parent.explanation}

Follow-up question: "${question}"

Answer in 2-4 sentences. Be specific and grounded in the lease. Do not give legal advice — explain and inform.
Return ONLY the answer text, no JSON, no markdown.
  `.trim();

  const answer = await callGemini(prompt, pdfBase64);

  const subId = `${parentId}_sub_${Date.now()}`;
  const subTerm = {
    id: subId,
    label: question,
    value: '',
    risk: parent.risk,
    explanation: answer,
    citation: parent.citation,
    market_note: '',
    source_text: '',
    source_page: parent.source_page,
    parentId,
    isSubtopic: true,
    savedQuestion: question
  };

  const parentIdx = leaseSummaryCache.findIndex(t => t.id === parentId);
  leaseSummaryCache.splice(parentIdx + 1, 0, subTerm);
  renderTerms(leaseSummaryCache);

  const parentCard = document.querySelector(`.term-card[data-id="${parentId}"]`);
  if (parentCard) parentCard.classList.add('open');
  const subCard = document.querySelector(`.term-card[data-id="${subId}"]`);
  if (subCard) {
    subCard.classList.add('just-added');
    subCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => subCard.classList.remove('just-added'), 2000);
  }
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
    const parsed = parseGeminiJSON(raw);

    // Also analyze any saved custom categories
    const customCategories = await loadCustomCategories();
    const customTerms = [];
    for (const cat of customCategories) {
      try {
        setLoadingStep(`Analyzing "${cat}"…`);
        const catPrompt = `
You are analyzing the attached residential lease PDF for a specific topic.

TOPIC: "${cat}"

Return ONLY valid JSON - no markdown, no code blocks:
{
  "id": "${cat.toLowerCase().replace(/\s+/g, '_')}",
  "label": "${cat}",
  "value": "What the lease says, or Not found",
  "risk": "low|medium|high|unknown",
  "explanation": "2-3 sentence explanation",
  "citation": "Relevant regulation or No specific regulation",
  "market_note": "Market comparison",
  "source_text": "",
  "source_page": 0
}

Keep all string values simple - no special characters or quotes within quotes.
`.trim();
        const catRaw = await callGemini(catPrompt, pdfBase64);
        customTerms.push(parseGeminiJSON(catRaw));
      } catch { /* skip failed custom categories */ }
    }

    leaseSummaryCache = [...parsed.terms, ...customTerms];
    renderTerms(leaseSummaryCache);
    showState('Results');
    
    // Show saved custom topics in memories section
    await renderMemories();

    // Re-analyze saved subtopics fresh against new lease
    const savedSubtopics = await loadSavedSubtopics();
    for (const sub of savedSubtopics) {
      try {
        setLoadingStep(`Analyzing saved question: "${sub.question}"…`);
        await analyzeSubtopic(sub.parentId, sub.question);
      } catch { /* skip failed subtopics */ }
    }

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