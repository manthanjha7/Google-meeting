const express = require('express');
const { getSettings, setSetting } = require('../db/queries');

const router = express.Router();

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) {
    console.error('Settings fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /api/settings
router.post('/', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object is required' });
    }
    for (const [key, value] of Object.entries(settings)) {
      await setSetting(key, String(value));
    }
    const updated = await getSettings();
    res.json({ settings: updated });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
