# Deployment Guide — Finrep Meeting Intelligence

## Overview

The system has two parts:
1. **Server** — runs on a shared machine/VPS. The whole team points to this one server.
2. **Chrome Extension** — installed on each team member's browser.

---

## Part 1: Server Setup

### Prerequisites
- A VPS or server with a public IP (e.g. AWS EC2, DigitalOcean Droplet, or any Linux machine)
- Node.js 18+ **or** Docker installed

### Step 1: Clone the repo on your server

```bash
git clone https://github.com/manthanjha7/Google-meeting.git
cd Google-meeting
```

### Step 2: Configure environment variables

```bash
cp .env.example .env
nano .env   # or use any editor
```

Fill in every value. Pay special attention to:

| Variable | Description |
|---|---|
| `SARVAM_API_KEY` | Your Sarvam AI key for transcription |
| `AZURE_OPENAI_*` | Your Azure OpenAI credentials |
| `SLACK_BOT_TOKEN` | Slack bot token for posting summaries |
| `SLACK_CHANNEL_ID` | Slack channel to post to |
| `API_SECRET` | **Generate this:** `openssl rand -hex 32` — keep it secret, share only with the team |

### Step 3A: Run with Docker (recommended)

```bash
# Update manifest.json host_permissions with your server IP first (see Part 2)
docker compose up -d

# Check it's running
curl http://YOUR_SERVER_IP:3001/api/health
```

Data is persisted in `./data/` on the host.

### Step 3B: Run without Docker

```bash
bash setup.sh      # installs deps and creates directories
npm run server     # start the server

# For production (auto-restart on crash):
npm install -g pm2
pm2 start server/index.js --name finrep
pm2 save && pm2 startup
```

### Step 4: Open port 3001

On your server's firewall, allow inbound TCP on port 3001:

```bash
# UFW (Ubuntu)
ufw allow 3001/tcp

# AWS: add an inbound rule to your Security Group for port 3001
```

### Step 5: Verify

```bash
curl http://YOUR_SERVER_IP:3001/api/health
# Should return: {"status":"ok","timestamp":"..."}
```

---

## Part 2: Update the Chrome Extension

Before distributing the extension to the team, update these two files:

### 1. `extension/manifest.json`

Replace `YOUR_SERVER_IP` with your actual server IP or domain:

```json
"host_permissions": [
  "http://localhost:3001/*",
  "http://YOUR_SERVER_IP:3001/*",
  ...
]
```

Remove the `localhost` entry if you don't need local dev.

### 2. Package the extension for distribution

```bash
npm run package-extension
```

This creates `extension.zip` in the project root. Share this file with your team.

---

## Part 3: Team Member Setup (Chrome Extension Install)

Each team member does this **once**:

1. Download `extension.zip` from the team shared drive / Slack
2. Unzip it anywhere on your computer
3. Open Chrome → `chrome://extensions/`
4. Enable **Developer Mode** (top right toggle)
5. Click **Load unpacked** → select the unzipped `extension/` folder
6. Click the extension icon → open **Settings**
7. Set:
   - **Server URL:** `http://YOUR_SERVER_IP:3001/api`
   - **API Secret:** *(the `API_SECRET` value from the server .env — ask your admin)*
8. Click Save

---

## Security Notes

- `API_SECRET` protects the server from unauthorized access. Treat it like a password.
- Don't commit `.env` to git (it's already in `.gitignore`).
- For production, put the server behind HTTPS using nginx + Let's Encrypt.
- The `uploads/` directory holds raw audio — ensure the server is not publicly accessible beyond port 3001.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Extension can't reach server | Check `host_permissions` in manifest includes your server IP |
| `401 Unauthorized` errors | API_SECRET mismatch — check extension settings vs server .env |
| Server crashes on start | Check `.env` has all required values filled in |
| No audio recorded | Chrome requires HTTPS or localhost for tab capture — use HTTP for local dev |
