// Background Service Worker

// Runs on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('Security Net installed');
});

// Listens for messages from sidebar and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callGemini') {
    callGeminiAPI(request.prompt, request.apiKey, request.pdfBase64, request.schema)
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

// Calls Gemini API — supports optional inline PDF and structured JSON output
// Retries automatically on rate-limit (429) errors with backoff
async function callGeminiAPI(prompt, apiKey, pdfBase64, schema, _retries = 3) {
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

  const body = {
    contents: [{ parts }]
  };

  // When a schema is provided, use structured output to guarantee valid JSON
  if (schema) {
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: schema
    };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const errBody = await response.json();
    // Retry on rate-limit (429) with exponential backoff
    if (response.status === 429 && _retries > 0) {
      const waitSec = Math.pow(2, 4 - _retries) * 10; // 10s, 20s, 40s
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return callGeminiAPI(prompt, apiKey, pdfBase64, schema, _retries - 1);
    }
    throw new Error(errBody.error?.message || 'Gemini API error');
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}
