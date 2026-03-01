function isPDFPage() {
  return (
    document.contentType === 'application/pdf' ||
    window.location.href.toLowerCase().endsWith('.pdf') ||
    !!document.querySelector('embed[type="application/pdf"]')
  );
}

function injectPDFViewer(pdfWidth) {
  if (document.getElementById('sn-pdf-frame')) return;
  const frame = document.createElement('iframe');
  frame.id = 'sn-pdf-frame';
  // Pass the exact pixel width so the viewer doesn't have to guess it
  frame.src = chrome.runtime.getURL('pdf_viewer/viewer.html') + '?w=' + pdfWidth;
  frame.style.cssText = `
    position: fixed;
    top: 0; left: 420px;
    width: ${pdfWidth}px; height: 100vh;
    border: none;
    z-index: 2147483646;
  `;
  document.body.appendChild(frame);
}

function injectSidebar() {
  if (document.getElementById('sn-sidebar-frame')) return;

  const frame = document.createElement('iframe');
  frame.id = 'sn-sidebar-frame';
  frame.src = chrome.runtime.getURL('sidebar/sidebar.html');
  frame.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 420px; height: 100vh;
    border: none;
    border-right: 1px solid #ddd;
    z-index: 2147483647;
    background: white;
    box-shadow: 4px 0 20px rgba(0,0,0,0.12);
  `;
  // Hide the native PDF underneath so there's no double scrollbar
  document.body.style.overflow = 'hidden';
  document.body.appendChild(frame);

  const pdfWidth = window.innerWidth - 420;
  injectPDFViewer(pdfWidth);

  window.addEventListener('message', (e) => {
    if (e.data?.action === 'snClose') {
      frame.remove();
      document.getElementById('sn-pdf-frame')?.remove();
      document.body.style.overflow = '';
    }
    if (e.data?.action === 'snJumpToPage' && e.data.page) {
      document.getElementById('sn-pdf-frame')?.contentWindow.postMessage({
        action: 'goToPage',
        page: e.data.page,
        text: e.data.text
      }, '*');
    }
  });
}

// Waits for the Popup
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.action === 'openSidebar') {
    chrome.storage.local.set({ pdfURL: window.location.href });
    injectSidebar();
    sendResponse({ ok: true });
  }
  if (req.action === 'isPDF') {
    sendResponse({ isPDF: isPDFPage() });
  }
  return true;
});
