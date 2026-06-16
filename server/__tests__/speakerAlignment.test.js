const { alignSpeakers } = require('../services/speakerAlignment');

describe('alignSpeakers', () => {
  test('maps two diarized speakers to the names that overlap them in time', () => {
    const segments = [
      { speaker: 'SPEAKER_0', startTime: 0, endTime: 10 },
      { speaker: 'SPEAKER_1', startTime: 10, endTime: 30 },
      { speaker: 'SPEAKER_0', startTime: 30, endTime: 40 },
    ];
    const spans = [
      { speaker: 'Rahul', tStartMs: 300, tEndMs: 9500 },
      { speaker: 'Priya', tStartMs: 10500, tEndMs: 29000 },
      { speaker: 'Rahul', tStartMs: 30500, tEndMs: 39000 },
    ];
    const { names, confidence } = alignSpeakers(segments, spans);
    expect(names).toEqual({ SPEAKER_0: 'Rahul', SPEAKER_1: 'Priya' });
    expect(confidence.SPEAKER_0).toBeGreaterThanOrEqual(0.55);
    expect(confidence.SPEAKER_1).toBeGreaterThanOrEqual(0.55);
  });

  test('returns empty when there are no caption spans', () => {
    const segments = [
      { speaker: 'SPEAKER_0', startTime: 0, endTime: 10 },
      { speaker: 'SPEAKER_1', startTime: 10, endTime: 20 },
    ];
    expect(alignSpeakers(segments, [])).toEqual({ names: {}, confidence: {} });
  });

  test('returns empty for the single-speaker (chunked-sync) path', () => {
    const segments = [
      { speaker: '0', startTime: 0, endTime: 25 },
      { speaker: '0', startTime: 25, endTime: 50 },
    ];
    const spans = [
      { speaker: 'Rahul', tStartMs: 0, tEndMs: 25000 },
      { speaker: 'Priya', tStartMs: 25000, tEndMs: 50000 },
    ];
    expect(alignSpeakers(segments, spans)).toEqual({ names: {}, confidence: {} });
  });

  test('omits a speaker when overlap is ambiguous (50/50)', () => {
    const segments = [
      { speaker: 'SPEAKER_0', startTime: 0, endTime: 10 },
      { speaker: 'SPEAKER_1', startTime: 100, endTime: 110 }, // second speaker so the guard passes
    ];
    const spans = [
      { speaker: 'Rahul', tStartMs: 0, tEndMs: 5000 },
      { speaker: 'Priya', tStartMs: 5000, tEndMs: 10000 },
    ];
    const { names } = alignSpeakers(segments, spans);
    // SPEAKER_0 is split exactly 50/50 → below 0.55 threshold → not assigned.
    expect(names.SPEAKER_0).toBeUndefined();
  });

  test('allows two diarized speakers to map to the same real name (over-segmentation)', () => {
    const segments = [
      { speaker: 'SPEAKER_0', startTime: 0, endTime: 10 },
      { speaker: 'SPEAKER_2', startTime: 20, endTime: 30 },
    ];
    const spans = [
      { speaker: 'Rahul', tStartMs: 0, tEndMs: 10000 },
      { speaker: 'Rahul', tStartMs: 20000, tEndMs: 30000 },
    ];
    const { names } = alignSpeakers(segments, spans);
    expect(names).toEqual({ SPEAKER_0: 'Rahul', SPEAKER_2: 'Rahul' });
  });

  test('ignores segments with null timestamps without crashing', () => {
    const segments = [
      { speaker: 'SPEAKER_0', startTime: null, endTime: null },
      { speaker: 'SPEAKER_1', startTime: 0, endTime: 10 },
    ];
    const spans = [{ speaker: 'Priya', tStartMs: 0, tEndMs: 9000 }];
    const { names } = alignSpeakers(segments, spans);
    expect(names.SPEAKER_1).toBe('Priya');
  });
});
