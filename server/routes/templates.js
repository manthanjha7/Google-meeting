const express = require('express');
const { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } = require('../db/queries');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const templates = await listTemplates();
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name = 'New Template', meeting_context = '' } = req.body;
    const createdById = req.headers['x-user-id'] || null;
    const createdByName = req.headers['x-user-name'] || null;
    const template = await createTemplate(name, meeting_context, createdById, createdByName);
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const template = await getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Not found' });
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, prompt } = req.body;
    const template = await updateTemplate(req.params.id, name, prompt);
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteTemplate(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
