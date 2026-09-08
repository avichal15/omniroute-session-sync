# omni-web-2-api- (OmniRoute Chrome Session & Cookie Auto-Sync Bridge)

Web 2 API Chrome Extension and Bridge for ChatGPT, Gemini, GLM / Z.ai, DeepSeek, and Kimi session auto-syncing.
Automated background cookie sync between **Google Chrome** and **OmniRoute** on Windows.
Keeps web-session model providers (**ChatGPT Web**, **Gemini Web**, **Z.ai Web**, **Qwen Web**, etc.) active and uninterrupted with zero manual copy-pasting.

---

## 🚀 How to Set Up in 1 Minute

### Step 1: Start the Local Sync Bridge
Double-click `scripts/start-bridge.bat` or run in PowerShell:
```powershell
cd c:\omni\bridge
node server.mjs
```
The bridge runs locally on `http://127.0.0.1:20129`.

### Step 2: Load the Chrome Extension
1. Open **Google Chrome** and go to: `chrome://extensions/`
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select the directory: `C:\omni\extension`
5. You're done! The extension icon **OmniRoute Session Sync** will appear in Chrome.

---

## ⚡ How It Works

1. **Passive Auto-Sync**: Whenever you chat or browse in `chat.z.ai`, `chatgpt.com`, or `gemini.google.com`, the extension automatically detects fresh session cookies and sends them to the local bridge.
2. **Periodic Background Sweep**: Every 10 minutes, the extension performs a sweep of all open sessions.
3. **Database Encryption & Hot Refresh**: The bridge encrypts the cookies with OmniRoute's `STORAGE_ENCRYPTION_KEY` and writes directly to `storage.sqlite`. OmniRoute picks up the fresh credentials within seconds.
4. **Manual Sync**: Click the extension icon in Chrome and hit **"Sync All Active Sessions"** anytime.
