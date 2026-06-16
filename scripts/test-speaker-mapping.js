// Throwaway end-to-end test of caption->speaker auto-mapping against the real DB + services.
// Creates a temp meeting with 2 diarized speakers + overlapping caption spans, runs the
// orchestrator, prints the result, then deletes the temp meeting. Run: node scripts/test-speaker-mapping.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

(async () => {
  const {
    createMeeting, updateTranscript, saveSegments, saveCaptionSpans,
    getMeeting, deleteMeeting,
  } = require('../server/db/queries');
  const { runSpeakerAutoMapping } = require('../server/services/speakerMapping');

  const id = 'TEST-spk-' + Date.now();
  try {
    await createMeeting(id, null, 40, 'Speaker mapping test', null);
    await updateTranscript(id, '[00:00] SPEAKER_0: hello\n[00:10] SPEAKER_1: hi there');

    // Two diarized speakers (seconds)
    await saveSegments(id, [
      { speaker: 'SPEAKER_0', text: 'hello', startTime: 0, endTime: 10, confidence: 0.9 },
      { speaker: 'SPEAKER_1', text: 'hi there', startTime: 10, endTime: 20, confidence: 0.9 },
    ]);

    // Caption spans (ms) — note DELIBERATELY different words + a ~600ms lag, to prove
    // alignment is timestamp-only and tolerant of text mismatch + small skew.
    await saveCaptionSpans(id, [
      { speaker: 'Manthan', textSnippet: 'namaste sab log', tStartMs: 600, tEndMs: 9800 },
      { speaker: 'Rishabh', textSnippet: 'haan bhai bolo', tStartMs: 10600, tEndMs: 19500 },
    ]);

    await runSpeakerAutoMapping(id);

    const m = await getMeeting(id);
    console.log('\n=== RESULT ===');
    console.log('speakerNames:    ', JSON.stringify(m.speakerNames));
    console.log('speakerNamesMeta:', JSON.stringify(m.speakerNamesMeta));
    const ok = m.speakerNames && m.speakerNames.SPEAKER_0 === 'Manthan' && m.speakerNames.SPEAKER_1 === 'Rishabh'
      && m.speakerNamesMeta && m.speakerNamesMeta.source === 'captions';
    console.log(ok ? '\nPASS — names mapped from captions despite different words + lag.' : '\nFAIL');
  } finally {
    await deleteMeeting(id);
    console.log('(temp meeting cleaned up)');
  }
})();
