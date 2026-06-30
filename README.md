# Finrep Meeting Intelligence

Internal meeting intelligence pipeline. A Chrome extension that auto-records Google Meet sessions, transcribes them via Sarvam STT (optimized for Hindi-English code-switching), summarizes them via an LLM (Azure OpenAI by default, with Groq and Ollama support), and delivers structured notes to Slack.

## Outcomes

Built and shipped as an internal tool for a remote, Hindi-English team that was losing meeting context across customer, GTM, and internal calls. What it delivers in practice:

- **Zero-effort capture.** Recording starts automatically when a Google Meet opens, so no one has to remember to hit record or take notes during the call. Meeting context is captured by default instead of depending on whoever had a free hand.
- **Accurate on code-switched speech.** Sarvam STT handles the Hindi-English mix that generic English transcription mangles, with speaker diarization, so the transcript is usable rather than noise.
- **Notes land where work happens.** Structured summaries post straight to Slack, tagged by call type (Internal / Customer / GTM / Product), so the right context reaches the right channel without a manual write-up step.
- **Searchable meeting memory.** Every meeting is stored with transcript, summary, and export (JSON / Markdown / PDF / TXT), plus embeddings-based retrieval so past meetings can be queried instead of re-watched.
- **Self-hosted, no per-seat cost.** Runs on the team's own backend with shared-secret auth and Docker deploy, so meeting data stays in-house and there is no per-user SaaS bill.

## Architecture

```
Chrome Extension ──► Backend API Server
(Tab Audio Capture)    ├── POST /api/upload      → Store audio
                       ├── POST /api/transcribe   → Sarvam STT (hi-en)
                       ├── POST /api/summarize    → LLM (Azure OpenAI / Groq / Ollama)
                       ├── POST /api/slack/send   → Slack
                       └── GET  /api/meetings     → Meeting history
```

## Setup

### Prerequisites

- Node.js 18+
- Chrome browser
- API keys: Sarvam AI (STT), Azure OpenAI (summarization), and a Slack bot token

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
4. Navigate to Google Meet, recording starts automatically

## Usage

1. Join a Google Meet, the extension auto-detects and starts recording
2. End the meeting, the extension processes the audio through the pipeline
3. Review the summary in the extension popup
4. Select the call type tag (Internal / Customer / GTM / Product)
5. Click "Send to Slack", structured notes post to your configured channel

## Configuration

Environment variables (`.env`):

| Variable | Description |
|---|---|
| `SARVAM_API_KEY` | Sarvam AI API key for STT |
| `LLM_PROVIDER` | Summarization provider: `azure` (default), `groq`, or `ollama` |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_DEPLOYMENT` | Azure deployment name (default: `gpt-4o`) |
| `GROQ_API_KEY` | Groq API key (only if `LLM_PROVIDER=groq`) |
| `OLLAMA_URL` | Ollama base URL (only if `LLM_PROVIDER=ollama`, default: `http://localhost:11434`) |
| `SLACK_BOT_TOKEN` | Slack bot token (`chat:write` scope) for thread-based posting |
| `SLACK_CHANNEL_ID` | Target Slack channel ID |
| `SLACK_WEBHOOK_URL` | Optional fallback for single-message posting (no thread support) |
| `API_SECRET` | Shared secret between the extension and the server |
| `PORT` | Server port (default: 3001) |
| `UPLOAD_DIR` | Audio upload directory (default: ./uploads) |

See `.env.example` for the full list of supported variables.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/upload` | Upload meeting audio (multipart) |
| POST | `/api/transcribe` | Transcribe audio via Sarvam STT |
| POST | `/api/summarize` | Summarize transcript via the configured LLM |
| POST | `/api/slack/send` | Send summary to Slack |
| GET | `/api/meetings` | List all meetings (filter: `?callType=`) |
| GET | `/api/meetings/:id` | Get a specific meeting |
| GET | `/api/health` | Health check |
