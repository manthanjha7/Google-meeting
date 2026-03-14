# Finrep Meeting Intelligence

Internal meeting intelligence pipeline — a Chrome extension that auto-records Google Meet sessions, transcribes them via Sarvam STT (optimized for Hindi-English code-switching), summarizes them via Claude, and delivers structured notes to Slack.

## Architecture

```
Chrome Extension ──► Backend API Server
(Tab Audio Capture)    ├── POST /api/upload      → Store audio
                       ├── POST /api/transcribe   → Sarvam STT (hi-en)
                       ├── POST /api/summarize    → Claude AI
                       ├── POST /api/slack/send   → Slack webhook
                       └── GET  /api/meetings     → Meeting history
```

## Setup

### Prerequisites

- Node.js 18+
- Chrome browser
- API keys: Sarvam AI, Anthropic (Claude), Slack webhook URL

### Backend

```bash
cp .env.example .env
# Fill in your API keys in .env

npm install
npm run server
```

### Chrome Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` folder
4. Navigate to Google Meet — recording starts automatically

## Usage

1. Join a Google Meet — the extension auto-detects and starts recording
2. End the meeting — the extension processes the audio through the pipeline
3. Review the summary in the extension popup
4. Select the call type tag (Internal / Customer / GTM / Product)
5. Click "Send to Slack" — structured notes post to your configured channel

## Configuration

Environment variables (`.env`):

| Variable | Description |
|---|---|
| `SARVAM_API_KEY` | Sarvam AI API key for STT |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `PORT` | Server port (default: 3000) |
| `UPLOAD_DIR` | Audio upload directory (default: ./uploads) |

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/upload` | Upload meeting audio (multipart) |
| POST | `/api/transcribe` | Transcribe audio via Sarvam STT |
| POST | `/api/summarize` | Summarize transcript via Claude |
| POST | `/api/slack/send` | Send summary to Slack |
| GET | `/api/meetings` | List all meetings (filter: `?callType=`) |
| GET | `/api/meetings/:id` | Get a specific meeting |
| GET | `/api/health` | Health check |
