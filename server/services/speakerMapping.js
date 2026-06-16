const {
  getMeeting,
  getSegments,
  getCaptionSpans,
  updateSpeakerNames,
  updateSpeakerNamesMeta,
} = require('../db/queries');
const { alignSpeakers } = require('./speakerAlignment');

const PART_MARKER_RE = /\[--- Part \d+ of/;

/**
 * After diarized transcription, auto-map SPEAKER_x → real names using Meet caption spans.
 * Best-effort: any failure is logged and swallowed so transcription is never affected.
 * No-ops gracefully when there are no captions, a single speaker, or a multi-part transcript.
 */
async function runSpeakerAutoMapping(meetingId) {
  try {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return;

    const spans = await getCaptionSpans(meetingId);
    if (!spans || spans.length === 0) return; // no captions → leave to LLM/manual fallback

    // Multi-part transcripts have per-part-relative segment times that don't share the single
    // global caption clock. Skip auto-map for v1; manual/LLM fallback still applies.
    if (meeting.transcript && PART_MARKER_RE.test(meeting.transcript)) {
      console.log(`[SpeakerMap] ${meetingId}: multi-part transcript — skipping caption auto-map`);
      return;
    }

    const segments = await getSegments(meetingId);
    if (!segments || segments.length === 0) return;

    // getSegments returns snake_case rows — normalize for the pure aligner.
    const normalized = segments.map((s) => ({
      speaker: s.speaker,
      startTime: s.start_time,
      endTime: s.end_time,
    }));

    const { names, confidence } = alignSpeakers(normalized, spans);
    if (Object.keys(names).length === 0) {
      console.log(`[SpeakerMap] ${meetingId}: no confident caption matches`);
      return;
    }

    // Never clobber an existing (manual) mapping — existing entries win on key conflict.
    const existing = meeting.speakerNames || {};
    const merged = { ...names, ...existing };
    await updateSpeakerNames(meetingId, merged);
    await updateSpeakerNamesMeta(meetingId, { source: 'captions', confidence });
    console.log(`[SpeakerMap] ${meetingId}: mapped ${Object.keys(names).length} speaker(s) from Meet captions`);
  } catch (err) {
    console.warn(`[SpeakerMap] auto-mapping failed for ${meetingId}:`, err.message);
  }
}

module.exports = { runSpeakerAutoMapping };
