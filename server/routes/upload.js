const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createMeeting } = require('../db/queries');

const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'audio/webm', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg',
      'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/flac', 'audio/x-flac',
      'video/webm', 'video/mp4', 'audio/x-wav',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype}`));
    }
  },
});

// POST /api/upload
router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const meetingId = uuidv4();
  const durationSeconds = req.body.durationSeconds
    ? parseInt(req.body.durationSeconds, 10)
    : null;
  const meetTitle = req.body.meetTitle || null;
  const meetUrl = req.body.meetUrl || null;

  const meeting = await createMeeting(meetingId, req.file.path, durationSeconds, meetTitle, meetUrl);

  res.json({
    meetingId: meeting.id,
    audioPath: meeting.audio_path,
  });
});

module.exports = router;
