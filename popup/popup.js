// popup/popup.js

const analyzeBtn = document.getElementById('analyzeBtn');
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const dot = document.getElementById('dot');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const keySaved = document.getElementById('keySaved');

// Load saved API key
chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
  if (apiKey) apiKeyInput.value = apiKey;
});

// Check if current tab is a PDF
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.tabs.sendMessage(tab.id, { action: 'isPDF' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusText.textContent = 'Open a lease PDF to begin';
      return;
    }
    if (res.isPDF) {
      statusText.textContent = 'PDF detected — ready to analyze';
      statusPill.classList.add('found');
      dot.classList.add('green');
      analyzeBtn.disabled = false;
    } else {
      statusText.textContent = 'No PDF found on this page';
    }
  });
});

// Save API key
saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.storage.local.set({ apiKey: key }, () => {
    keySaved.style.display = 'block';
    setTimeout(() => keySaved.style.display = 'none', 2000);
  });
});

// Trigger analysis
analyzeBtn.addEventListener('click', () => {
  chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
    if (!apiKey) {
      alert('Please enter and save your Gemini API key first.');
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(tab.id, { action: 'openSidebar' }, () => {
        window.close();
      });
    });
  });
});
