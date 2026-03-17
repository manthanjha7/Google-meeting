# Improvements from Meetily — Implementation Plan

## What Meetily Does Well vs Our Current State

| Feature | Meetily | Finrep (Ours) | Gap |
|---------|---------|---------------|-----|
| Transcription | Local Whisper/Parakeet (real-time) | Sarvam cloud API (post-recording) | No live transcription |
| Speaker ID | Silero embeddings (PRO, WIP) | Sarvam diarization (SPEAKER_0/1) | Same level |
| Audio capture | System audio + mic (CPAL) | Tab audio + mic (Chrome tabCapture) | Ours is fine for web meetings |
| Audio processing | RNNoise, EBU R128 normalization | None | Could improve quality |
| Summary | 6 LLM providers (Ollama, Claude, GPT, Groq, etc.) | Claude only (disabled) | Single provider |
| Dashboard | Full Next.js web UI | Popup only, no dashboard | Major gap |
| Meeting history | Full UI with search | API-only | Major gap |
| Export | Multiple formats | None | Gap |
| Transcript editing | Rich text editor (BlockNote) | None | Gap |
| Audio import | Drop files, auto-transcribe | None | Nice to have |
| Re-transcription | Re-process with different model | None | Nice to have |
| Recovery | Auto-detect interrupted sessions | None | Good for reliability |

---

## Proposed Improvements (Prioritized)

### P0 — High Impact, Feasible Now

#### 1. Meeting Dashboard Web UI
**What:** A simple web page served by our Express server to browse meetings, view transcripts, and see summaries.
**Why:** Currently meetings are only accessible via API calls or the popup. No way to review past meetings.
**Approach:** Add a `/dashboard` route serving a single HTML page with vanilla JS (no React needed). Shows:
- Meeting list (sorted by date, filterable by call type)
- Click to expand: transcript, summary, audio playback
- Search across transcripts

#### 2. Transcript Export
**What:** Download transcripts as TXT or PDF from the dashboard/API.
**Why:** Users need to share meeting notes outside the app.
**Approach:** Add `GET /api/meetings/:id/export?format=txt|pdf` endpoint. TXT is trivial; PDF via a lightweight lib.

#### 3. Multi-Provider LLM Support for Summarization
**What:** Support Groq, OpenAI, and Ollama (local) in addition to Claude.
**Why:** Claude key isn't always available. Groq is fast and cheap. Ollama is free and private.
**Approach:** Abstract summarizer.js into a provider pattern. Add Groq (fastest, free tier), OpenAI (widely available), and Ollama (local, no API key needed). User picks provider in `.env`.

#### 4. Meeting Title from Google Meet
**What:** Capture the actual meeting title from the Google Meet tab instead of relying on Claude to generate one.
**Why:** Title is currently `null` until summarization runs. Users can't identify meetings.
**Approach:** Content script reads the meeting title from the DOM (`document.title` or the meeting name element) and sends it with MEET_DETECTED. Store as default title.

### P1 — Medium Impact

#### 5. Audio Quality Improvements
**What:** Add basic noise suppression and loudness normalization to the audio before sending to Sarvam.
**Why:** Cleaner audio = better transcription accuracy.
**Approach:** Use Web Audio API in offscreen.js — add a DynamicsCompressorNode and BiquadFilterNode (high-pass at 100Hz to remove hum) to the audio pipeline before MediaRecorder.

#### 6. Transcript Search API
**What:** Full-text search across all meeting transcripts.
**Why:** Users need to find "that thing someone said last week."
**Approach:** SQLite FTS5 (full-text search) virtual table on transcripts. Add `GET /api/meetings/search?q=keyword` endpoint.

#### 7. Meeting Recovery on Extension Restart
**What:** Detect incomplete recordings on startup and offer recovery.
**Why:** If browser crashes mid-recording, audio data is lost.
**Approach:** Periodically save recording state to chrome.storage. On extension restart, check for incomplete state and prompt user.

#### 8. Re-transcription Endpoint
**What:** Allow re-running transcription on existing audio files.
**Why:** If diarization wasn't working (like our recent fix), users can re-process old meetings.
**Approach:** Add `POST /api/retranscribe` that reads the stored audio file and runs Sarvam again.

### P2 — Nice to Have

#### 9. Audio Import
**What:** Upload external audio files (MP3, WAV, etc.) for transcription.
**Why:** Useful for meetings recorded outside Google Meet.
**Approach:** Add file upload UI to dashboard. Server already accepts multiple audio formats.

#### 10. Configurable Chunk Duration
**What:** Let users set the auto-chunk interval (currently hardcoded 55 min).
**Why:** Some users may want shorter chunks for faster intermediate results.
**Approach:** Add setting in extension popup or `.env`.

---

## What We Should NOT Copy from Meetily

1. **Tauri/Rust desktop app** — We're a Chrome extension, which is simpler and requires no install. Our architecture is better for web meetings.
2. **Local Whisper/Parakeet** — Requires GPU and large model downloads. Sarvam cloud is better for Hindi-English and requires no setup.
3. **Complex audio pipeline (CPAL, FFmpeg)** — Chrome's tabCapture already gives us clean audio. Over-engineering.
4. **PostHog analytics** — Not needed at this stage.
5. **Silero VAD** — Sarvam handles speech detection server-side.
6. **BlockNote rich text editor** — Over-complex for our use case. Simple HTML rendering is enough for now.
