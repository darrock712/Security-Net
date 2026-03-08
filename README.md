# Security Net 

An AI Google Chrome extension focused on the safety of users from unfair leases. It aims to get users to better understand what they're signing for.

It goes through each document summarizing key sections and flagging potential risks that the user may miss or want to look further into. These flags are broken down into verification from Seattle regulations and the analysis continues to develop based off of the user's preferences.

## API Key Setup

You need a free Gemini API key to run this. It's not in the repo for so you need to add it yourself

### Getting the key
1. Go to https://aistudio.google.com/
2. Sign in with a Google account
3. Click Get API key → Create API key
4. Copy it, it starts with `AIza...`

### Adding it to the extension
1. Load the extension first (see below)
2. Click the shield icon in the toolbar
3. Paste the key in the API key field
4. Hit Save API Key

The key saves to Chrome's local storage and stays off the repo


## How to Run It

### 1. Clone the repo and install dependencies
```bash
git clone <your-gitlab-repo-url>
cd project-e
npm install
```

### 2. Build the PDF viewer
```bash
npm run build
```
This bundles `viewer/viewer.js` → `viewer/viewer.bundle.js`. You need to re-run this after any changes to `viewer/viewer.js`.

Tip: run `npm run watch` to auto-rebuild on save.

### 3. Load it in Chrome
1. Go to `chrome://extensions/`
2. Turn on Developer mode (top right)
3. Click Load unpacked
4. Select the security-net folder
5. The shield icon shows up in your toolbar

### 4. Add your API key
Follow the steps that were listed above

### 5. Test it
1. Drag any lease PDF into a Chrome tab
2. Click the shield icon
3. Click Analyze This Lease
4. Sidebar opens and starts analyzing

> You need to have a PDF open in the active tab for the analysis to work.

---

## After Changing Code

Chrome won't auto-reload so after any edit:
1. If you changed `viewer/viewer.js`, rebuild with `npm run build` (or use `npm run watch`)
2. Go to `chrome://extensions/`
3. Hit the refresh icon on Security Net
4. Reopen the PDF tab

> **Note:** All other files (sidebar, popup, background, content scripts) don't need a build step — only `viewer/viewer.js` requires bundling because it uses npm packages.

---