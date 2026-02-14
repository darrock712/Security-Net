// Background Service Worker

// Runs on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('Security Net installed');
});

// Listens for messages from sidebar and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callGemini') {
    callGeminiAPI(request.prompt, request.apiKey, request.pdfBase64)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchPDF') {
    fetchPDFAsBase64(request.url)
      .then(base64 => sendResponse({ success: true, data: base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Fetches a PDF from a URL and returns base64-encoded data
async function fetchPDFAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch PDF');
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Calls Gemini API — supports optional inline PDF
async function callGeminiAPI(prompt, apiKey, pdfBase64) {
  const parts = [{ text: prompt }];

  // If we have PDF data, send it inline so Gemini can read it directly
  if (pdfBase64) {
    parts.unshift({
      inline_data: {
        mime_type: 'application/pdf',
        data: pdfBase64
      }
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }]
      })
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Gemini API error');
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}
