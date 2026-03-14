const express = require('express');
const { listMeetings, getMeeting } = require('../db/queries');

const router = express.Router();

// GET /api/meetings
router.get('/', async (req, res) => {
  const { callType } = req.query;
  const meetings = await listMeetings(callType || null);
  res.json({ meetings });
});

// GET /api/meetings/:id
router.get('/:id', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ meeting });
});

module.exports = router;
