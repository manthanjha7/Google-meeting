const express = require('express');
const multer = require('multer');
const { ingestDocument, queryKb, listDocuments, deleteDocument } = require('../services/kb');
const { getSettings } = require('../db/queries');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/kb/documents — list all KB documents
router.get('/documents', async (req, res) => {
  try {
    const docs = await listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list documents: ' + err.message });
  }
});

// POST /api/kb/ingest — ingest plain text or uploaded file
// Body (JSON): { text, filename }
// OR multipart: file upload
router.post('/ingest', upload.single('file'), async (req, res) => {
  try {
    const settings = await getSettings();
    let text, filename;

    if (req.file) {
      // File upload
      text = req.file.buffer.toString('utf-8');
      filename = req.file.originalname;
    } else if (req.body.text) {
      text = req.body.text;
      filename = req.body.filename || 'pasted_text.txt';
    } else {
      return res.status(400).json({ error: 'Provide either a file upload or { text, filename } in body' });
    }

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Document text is too short' });
    }

    const result = await ingestDocument(text, filename, settings);

    if (result.skipped) {
      return res.json({ skipped: true, documentId: result.documentId, message: 'Document already ingested (duplicate content)' });
    }

    res.json({ documentId: result.documentId, chunkCount: result.chunkCount, filename });
  } catch (err) {
    console.error('KB ingest error:', err);
    res.status(500).json({ error: 'Ingest failed: ' + err.message });
  }
});

// POST /api/kb/ingest-meeting/:id — ingest a meeting's transcript into the KB
router.post('/ingest-meeting/:id', async (req, res) => {
  try {
    const { getMeeting } = require('../db/queries');
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!meeting.transcript) return res.status(400).json({ error: 'No transcript available' });

    const settings = await getSettings();
    const title = meeting.title || meeting.meet_title || `meeting_${req.params.id}`;
    const filename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    const result = await ingestDocument(meeting.transcript, filename, settings);

    if (result.skipped) {
      return res.json({ skipped: true, message: 'Transcript already in knowledge base' });
    }

    res.json({ documentId: result.documentId, chunkCount: result.chunkCount, filename });
  } catch (err) {
    console.error('KB ingest-meeting error:', err);
    res.status(500).json({ error: 'Ingest failed: ' + err.message });
  }
});

// POST /api/kb/query — query the knowledge base
router.post('/query', async (req, res) => {
  const { question, topK = 5 } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  try {
    const settings = await getSettings();
    const result = await queryKb(question.trim(), settings, Math.min(topK, 10));
    res.json(result);
  } catch (err) {
    console.error('KB query error:', err);
    res.status(500).json({ error: 'Query failed: ' + err.message });
  }
});

// DELETE /api/kb/documents/:id — delete a document and its chunks
router.delete('/documents/:id', async (req, res) => {
  try {
    await deleteDocument(req.params.id);
    res.json({ success: true, deletedId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

module.exports = router;
