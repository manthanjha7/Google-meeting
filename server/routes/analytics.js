const express = require('express');
const { getDb } = require('../db/schema');

const router = express.Router();

// GET /api/analytics
// Returns aggregated stats across all meetings for the dashboard analytics tab.
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Total meetings
    const totalRow = db.exec('SELECT COUNT(*) AS n FROM meetings')[0];
    const totalMeetings = totalRow ? totalRow.values[0][0] : 0;

    // Total duration (seconds)
    const durRow = db.exec('SELECT SUM(duration_seconds) AS s FROM meetings')[0];
    const totalDurationSec = durRow ? (durRow.values[0][0] || 0) : 0;

    // Average duration (only meetings with duration recorded)
    const avgRow = db.exec('SELECT AVG(duration_seconds) AS a FROM meetings WHERE duration_seconds > 0')[0];
    const avgDurationSec = avgRow ? Math.round(avgRow.values[0][0] || 0) : 0;

    // Meetings by call type
    const typeRows = db.exec(`
      SELECT COALESCE(call_type, 'unknown') AS type, COUNT(*) AS n
      FROM meetings GROUP BY type ORDER BY n DESC
    `);
    const byCallType = {};
    if (typeRows[0]) {
      typeRows[0].values.forEach(([type, count]) => { byCallType[type] = count; });
    }

    // Meetings per week — last 8 weeks
    const weekRows = db.exec(`
      SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS n
      FROM meetings
      WHERE created_at >= datetime('now', '-56 days')
      GROUP BY week ORDER BY week ASC
    `);
    const perWeek = weekRows[0]
      ? weekRows[0].values.map(([week, count]) => ({ week, count }))
      : [];

    // Meetings per day — last 30 days
    const dayRows = db.exec(`
      SELECT date(created_at) AS day, COUNT(*) AS n
      FROM meetings
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY day ORDER BY day ASC
    `);
    const perDay = dayRows[0]
      ? dayRows[0].values.map(([day, count]) => ({ day, count }))
      : [];

    // Total action items across all summarised meetings
    let totalActionItems = 0;
    const aiRows = db.exec("SELECT summary FROM meetings WHERE summary IS NOT NULL AND summary != ''");
    if (aiRows[0]) {
      aiRows[0].values.forEach(([summaryJson]) => {
        try {
          const s = JSON.parse(summaryJson);
          if (Array.isArray(s.actionItems)) totalActionItems += s.actionItems.length;
        } catch { /* skip malformed */ }
      });
    }

    // Top participants (from summary.participants arrays)
    const participantCounts = {};
    if (aiRows[0]) {
      aiRows[0].values.forEach(([summaryJson]) => {
        try {
          const s = JSON.parse(summaryJson);
          if (Array.isArray(s.participants)) {
            s.participants.forEach((p) => {
              participantCounts[p] = (participantCounts[p] || 0) + 1;
            });
          }
        } catch { /* skip */ }
      });
    }
    const topParticipants = Object.entries(participantCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    res.json({
      totalMeetings,
      totalDurationSec,
      avgDurationSec,
      totalActionItems,
      byCallType,
      perWeek,
      perDay,
      topParticipants,
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Analytics failed: ' + err.message });
  }
});

module.exports = router;
