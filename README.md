# Security Net 

An AI Google Chrome extension focused on the safety of users from unfair leases. It aims to get users to better understand what they're signing for.

It goes through each document summarizing key sections and flagging potential risks that the user may miss or want to look further into. These flags are broken down into verification from regulations from the user's current location and continues to develop based off of the user's preferences 

(Maybe on the location for now EDIT LATER)

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

### 1. Clone the repo
```bash
git clone https://gitlab.com/YOUR_USERNAME/security-net.git
cd security-net
```

### 2. Load it in Chrome
1. Go to `chrome://extensions/`
2. Turn on Developer mode (top right)
3. Click Load unpacked
4. Select the security-net folder
5. The shield icon shows up in your toolbar

### 3. Add your API key
Follow the steps that were listed above

### 4. Test it
1. Drag any lease PDF into a Chrome tab
2. Click the shield icon
3. Click Analyze This Lease
4. Sidebar opens and starts analyzing

> It falls back to a demo lease automatically so you can still test the full flow without a lease/pdf open.

---

## After Changing Code

Chrome won't auto-reload so after any edit:
1. Go to `chrome://extensions/`
2. Hit the refresh icon on Security Net
3. Reopen the PDF tab

---