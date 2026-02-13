function isPDFPage() {
  return (
    document.contentType === 'application/pdf' ||
    window.location.href.toLowerCase().endsWith('.pdf') ||
    !!document.querySelector('embed[type="application/pdf"]')
  );
}

function injectSidebar() {
  if (document.getElementById('sn-sidebar-frame')) return;

  const frame = document.createElement('iframe');
  frame.id = 'sn-sidebar-frame';
  frame.src = chrome.runtime.getURL('sidebar/sidebar.html');
  frame.style.cssText = `
    position: fixed;
    top: 0; right: 0;
    width: 420px; height: 100vh;
    border: none;
    border-left: 1px solid #ddd;
    z-index: 2147483647;
    background: white;
    box-shadow: -4px 0 20px rgba(0,0,0,0.12);
  `;
  document.body.style.marginRight = '420px';
  document.body.appendChild(frame);

  // Remove Function
  window.addEventListener('message', (e) => {
    if (e.data?.action === 'snClose') {
      frame.remove();
      document.body.style.marginRight = '';
    }
  });
}

// Waits for the Popup
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'openSidebar') {
    injectSidebar();
    sendResponse({ ok: true });
  }
  if (req.action === 'isPDF') {
    sendResponse({ isPDF: isPDFPage() });
  }
  return true;
});
