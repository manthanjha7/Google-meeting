const express = require('express');
const { getMeeting, updateCallType, markSlackPosted, getSettings } = require('../db/queries');
const { postToSlack, postToSlackThread } = require('../services/slack');

const router = express.Router();

// POST /api/slack/send
// Auto-selects thread posting (bot token) over webhook when both are configured.
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

    const resolvedCallType = callType || meeting.call_type || 'internal';
    const settings = await getSettings();

    // Prefer bot token (thread posting) over webhook
    const hasBotToken = settings.slack_bot_token || process.env.SLACK_BOT_TOKEN;
    const hasChannel = settings.slack_channel_id || process.env.SLACK_CHANNEL_ID;

    let threadTs = null;
    if (hasBotToken && hasChannel) {
      const result = await postToSlackThread(meeting.summary, resolvedCallType, settings);
      threadTs = result.threadTs;
    } else {
      await postToSlack(meeting.summary, resolvedCallType);
    }

    await markSlackPosted(meetingId, threadTs);
    res.json({ success: true, meetingId, threadTs, mode: threadTs ? 'thread' : 'webhook' });
  } catch (err) {
    console.error('Slack send error:', err);
    res.status(500).json({ error: `Slack send failed: ${err.message}` });
  }
});

module.exports = router;
