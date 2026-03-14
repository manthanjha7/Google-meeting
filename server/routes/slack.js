const express = require('express');
const { getMeeting, updateCallType, markSlackPosted } = require('../db/queries');
const { postToSlack } = require('../services/slack');

const router = express.Router();

// POST /api/slack/send
router.post('/send', async (req, res) => {
  const { meetingId, callType } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const validCallTypes = ['internal', 'customer', 'gtm', 'product'];
  if (callType && !validCallTypes.includes(callType)) {
    return res.status(400).json({
      error: `Invalid callType. Must be one of: ${validCallTypes.join(', ')}`,
    });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.summary) {
    return res.status(400).json({ error: 'No summary available. Run summarization first.' });
  }

  try {
    if (callType) {
      await updateCallType(meetingId, callType);
    }

    await postToSlack(meeting.summary, callType || meeting.call_type || 'internal');
    await markSlackPosted(meetingId);

    res.json({ success: true, meetingId });
  } catch (err) {
    console.error('Slack send error:', err);
    res.status(500).json({ error: `Slack send failed: ${err.message}` });
  }
});

module.exports = router;
