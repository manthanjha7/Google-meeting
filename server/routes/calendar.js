const express = require('express');
const { getMeeting, updateCalendarData, updateMeetTitle } = require('../db/queries');

const router = express.Router();

/**
 * POST /api/calendar/enrich
 * Called by the Chrome extension after it fetches the Google Calendar event
 * matching the current Meet URL. Enriches the meeting record with event metadata.
 *
 * Body: { meetingId, eventId, title, attendees: [...], description }
 */
router.post('/enrich', async (req, res) => {
  const { meetingId, eventId, title, attendees, description } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'meetingId is required' });

  const meeting = await getMeeting(meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  try {
    // If the meeting has no title yet, use the calendar event title
    if (title && !meeting.title && !meeting.meet_title) {
      await updateMeetTitle(meetingId, title);
    }
    await updateCalendarData(meetingId, {
      eventId,
      attendees: Array.isArray(attendees) ? attendees : [],
      description,
    });
    const updated = await getMeeting(meetingId);
    res.json({ success: true, meeting: updated });
  } catch (err) {
    console.error('Calendar enrich error:', err);
    res.status(500).json({ error: 'Failed to enrich: ' + err.message });
  }
});

module.exports = router;
