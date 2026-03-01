import * as pdfjsLib from '../pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs/pdf.worker.mjs');

const viewerEl = document.getElementById('viewer');
const loadingEl = document.getElementById('loading');

// Load PDF via the background worker (same way the sidebar does)
chrome.storage.local.get(['pdfURL'], ({ pdfURL }) => {
  if (!pdfURL) { loadingEl.textContent = 'No PDF found.'; return; }
  chrome.runtime.sendMessage({ action: 'fetchPDF', url: pdfURL }, async (res) => {
    if (!res?.success) { loadingEl.textContent = 'Error loading PDF: ' + (res?.error || 'unknown'); return; }
    try {
      const binary = atob(res.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
      loadingEl.style.display = 'none';
      await renderAll(pdfDoc);
    } catch (err) {
      loadingEl.textContent = 'Error rendering PDF: ' + err.message;
    }
  });
});

async function renderAll(pdfDoc) {
  // Width is passed as a URL param by the content script — no DOM measurement needed
  const params = new URLSearchParams(window.location.search);
  const targetWidth = (parseInt(params.get('w')) || document.documentElement.clientWidth) - 40;
  for (let num = 1; num <= pdfDoc.numPages; num++) {
    const page = await pdfDoc.getPage(num);
    const scale = targetWidth / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    pageDiv.id = 'page-' + num;
    pageDiv.style.width = Math.floor(viewport.width) + 'px';
    pageDiv.style.height = Math.floor(viewport.height) + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    pageDiv.appendChild(textLayerDiv);

    viewerEl.appendChild(pageDiv);

    // Render canvas
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // Render text layer (handles PDF.js 3.x and 4.x)
    const textContent = await page.getTextContent();
    if (pdfjsLib.TextLayer) {
      const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
      await tl.render();
    } else if (pdfjsLib.renderTextLayer) {
      const task = pdfjsLib.renderTextLayer({ textContent, container: textLayerDiv, viewport, textDivs: [] });
      await (task.promise ?? task);
    }
  }
}

// Handle jump commands from the content script
window.addEventListener('message', (e) => {
  if (e.data?.action !== 'goToPage') return;
  const pageEl = document.getElementById('page-' + e.data.page);
  if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (e.data.text) {
    // window.find() works here because the text layer IS in the DOM
    setTimeout(() => window.find(e.data.text, false, false, true, false, false, false), 400);
  }
});
