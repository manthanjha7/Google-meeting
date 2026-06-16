// Map Sarvam's anonymous diarized speakers (SPEAKER_0..N) to real names by aligning them
// against Google Meet caption spans (which carry real speaker names) on the time axis.
//
// Pure module — no I/O. Takes arrays, returns { names, confidence }. This is the testable core.

const CONF_THRESHOLD = 0.55;   // a speaker's winning name must own >=55% of its overlapped time
const MIN_OVERLAP_SEC = 2.0;   // ...and at least 2s of overlap, to reject noise

/**
 * @param {Array<{speaker:string, startTime:number|null, endTime:number|null}>} diarizedSegments
 *        Sarvam segments, times in SECONDS.
 * @param {Array<{speaker:string, tStartMs:number, tEndMs:number}>} captionSpans
 *        Meet caption spans, times in MILLISECONDS relative to audio start.
 * @returns {{ names: Record<string,string>, confidence: Record<string,number> }}
 */
function alignSpeakers(diarizedSegments, captionSpans) {
  const empty = { names: {}, confidence: {} };
  if (!Array.isArray(diarizedSegments) || !Array.isArray(captionSpans)) return empty;
  if (captionSpans.length === 0) return empty;

  // Guard: with a single (or zero) diarized speaker there is nothing to disambiguate —
  // e.g. the chunked-sync path emits one speaker "0". Mapping it to the most-talkative
  // caption name would be wrong, so fall through to the fallback chain.
  const uniqueSpeakers = new Set(
    diarizedSegments.map((s) => s.speaker).filter((s) => s != null)
  );
  if (uniqueSpeakers.size <= 1) return empty;

  // Normalize caption spans to seconds.
  const spans = captionSpans
    .filter((s) => s && s.speaker && s.tStartMs != null && s.tEndMs != null)
    .map((s) => ({ name: s.speaker, start: s.tStartMs / 1000, end: s.tEndMs / 1000 }))
    .filter((s) => s.end > s.start);
  if (spans.length === 0) return empty;

  // votes[speaker][name] = total overlap seconds
  const votes = {};
  for (const seg of diarizedSegments) {
    if (seg.startTime == null || seg.endTime == null || seg.speaker == null) continue;
    for (const sp of spans) {
      const ov = Math.min(seg.endTime, sp.end) - Math.max(seg.startTime, sp.start);
      if (ov > 0) {
        votes[seg.speaker] = votes[seg.speaker] || {};
        votes[seg.speaker][sp.name] = (votes[seg.speaker][sp.name] || 0) + ov;
      }
    }
  }

  const names = {};
  const confidence = {};
  for (const speaker of Object.keys(votes)) {
    const nameVotes = votes[speaker];
    let total = 0;
    let bestName = null;
    let bestOverlap = 0;
    for (const name of Object.keys(nameVotes)) {
      const v = nameVotes[name];
      total += v;
      if (v > bestOverlap) { bestOverlap = v; bestName = name; }
    }
    const conf = total > 0 ? bestOverlap / total : 0;
    // Duplicate names across speakers are allowed (Sarvam sometimes over-segments one person).
    if (bestName && conf >= CONF_THRESHOLD && bestOverlap >= MIN_OVERLAP_SEC) {
      names[speaker] = bestName;
      confidence[speaker] = Math.round(conf * 100) / 100;
    }
  }

  return { names, confidence };
}

module.exports = { alignSpeakers, CONF_THRESHOLD, MIN_OVERLAP_SEC };
