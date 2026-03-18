const express = require('express');
const { getMeeting, updateSummary, getSettings } = require('../db/queries');

/**
 * Apply speaker name mapping to a transcript.
 * Replaces SPEAKER_0, SPEAKER_1, etc. with real names where known.
 */
function applyNames(transcript, speakerNames) {
  if (!speakerNames || Object.keys(speakerNames).length === 0) return transcript;
  let result = transcript;
  for (const [label, name] of Object.entries(speakerNames)) {
    if (name && name.trim()) {
      result = result.replace(new RegExp(label, 'g'), name.trim());
    }
  }
  return result;
}
const { summarize, summarizeStream } = require('../services/summarizer');

const router = express.Router();

// Summary templates
const TEMPLATES = {
  default: null, // uses the built-in prompt
  standup: `Focus on: what each person did yesterday, what they plan to do today, and blockers mentioned. Format action items by person.`,
  customer: `Focus on: customer pain points, feature requests, satisfaction signals, and commitments made by our team. Highlight any deadlines or follow-ups promised to the customer.`,
  product: `Focus on: product decisions, feature prioritization, technical trade-offs discussed, and timeline commitments. Group action items by feature area.`,
};

// POST /api/summarize — standard (non-streaming)
router.post('/', async (req, res) => {
  const { meetingId, template, customPrompt } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.transcript || meeting.transcript.trim().length === 0) {
    return res.status(400).json({
      error: 'No transcript available. The audio recording may have been silent.',
    });
  }

  try {
    // Build extra instructions from template or custom prompt
    let extraInstructions = '';
    if (customPrompt) {
      extraInstructions = customPrompt;
    } else if (template && TEMPLATES[template]) {
      extraInstructions = TEMPLATES[template];
    }

    const settings = await getSettings();
    // Apply speaker name mapping before summarizing (if names have been set)
    const transcript = applyNames(meeting.transcript, meeting.speakerNames);
    const summary = await summarize(transcript, extraInstructions, settings);
    await updateSummary(meetingId, summary);

    res.json({ meetingId, summary });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: `Summarization failed: ${err.message}` });
  }
});

// GET /api/summarize/stream?meetingId=...&template=...&customPrompt=...  — SSE streaming
router.get('/stream', async (req, res) => {
  const { meetingId, template, customPrompt } = req.query;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.transcript || meeting.transcript.trim().length === 0) {
    return res.status(400).json({
      error: 'No transcript available.',
    });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    let extraInstructions = '';
    if (customPrompt) {
      extraInstructions = customPrompt;
    } else if (template && TEMPLATES[template]) {
      extraInstructions = TEMPLATES[template];
    }

    const settings = await getSettings();
    let fullText = '';
    await summarizeStream(meeting.transcript, extraInstructions, (chunk) => {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    }, settings);

    // Parse the final result and save
    try {
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const summary = JSON.parse(jsonMatch[0]);
        // Fill required fields
        for (const f of ['title', 'summary']) {
          if (!(f in summary)) summary[f] = '';
        }
        for (const f of ['decisions', 'actionItems', 'followUps', 'deadlines', 'nextSteps', 'participants']) {
          if (!(f in summary) || !Array.isArray(summary[f])) summary[f] = [];
        }
        await updateSummary(meetingId, summary);
        res.write(`data: ${JSON.stringify({ type: 'done', summary })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to parse summary' })}\n\n`);
      }
    } catch (parseErr) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to parse summary JSON' })}\n\n`);
    }
  } catch (err) {
    console.error('Streaming summarization error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }

  res.end();
});

// GET /api/summarize/templates — list available templates
router.get('/templates', (req, res) => {
  const templateList = Object.entries(TEMPLATES).map(([key, prompt]) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    description: prompt || 'Default meeting summary template',
  }));
  res.json({ templates: templateList });
});

module.exports = router;
