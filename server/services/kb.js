/**
 * Personal Knowledge Base service.
 *
 * Uses Azure OpenAI text-embedding-ada-002 to embed text chunks,
 * stores them in kb_chunks with JSON-serialised float32 embeddings,
 * and performs cosine-similarity retrieval for RAG queries.
 */

const { AzureOpenAI, OpenAI } = require('openai');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db/schema');

// ---- Embedding client ----

function buildEmbedClient(settings = {}) {
  const provider = settings.llm_provider || 'azure';

  if (provider === 'groq' || provider === 'ollama') {
    // Use Azure for embeddings regardless of chat provider
    // (Groq/Ollama don't have a standard embeddings endpoint)
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
  const embeddingDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-ada-002';

  if (!endpoint || !apiKey) throw new Error('Azure OpenAI not configured for embeddings');

  return {
    client: new AzureOpenAI({ endpoint, apiKey, apiVersion }),
    model: embeddingDeployment,
  };
}

// ---- Text chunking ----

const CHUNK_SIZE = 500;   // words per chunk
const CHUNK_OVERLAP = 50; // words overlap between chunks

function chunkText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + CHUNK_SIZE).join(' ');
    if (chunk.trim()) chunks.push(chunk);
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ---- Embeddings ----

async function embedTexts(texts, settings = {}) {
  const { client, model } = buildEmbedClient(settings);
  const response = await client.embeddings.create({ model, input: texts });
  return response.data.map((d) => d.embedding);
}

// ---- Cosine similarity ----

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ---- DB helpers ----

async function insertDocument(filename, contentHash) {
  const db = await getDb();
  const id = uuidv4();
  db.run(
    `INSERT INTO kb_documents (id, filename, content_hash) VALUES (?, ?, ?)`,
    [id, filename, contentHash]
  );
  saveDb();
  return id;
}

async function insertChunks(documentId, chunks, embeddings) {
  const db = await getDb();
  chunks.forEach((text, i) => {
    const embeddingJson = JSON.stringify(embeddings[i]);
    db.run(
      `INSERT INTO kb_chunks (document_id, chunk_text, embedding, chunk_index) VALUES (?, ?, ?, ?)`,
      [documentId, text, embeddingJson, i]
    );
  });
  saveDb();
}

async function getAllChunksWithEmbeddings() {
  const db = await getDb();
  const rows = db.exec(`
    SELECT kc.id, kc.chunk_text, kc.embedding, kd.filename
    FROM kb_chunks kc
    JOIN kb_documents kd ON kc.document_id = kd.id
    WHERE kc.embedding IS NOT NULL
  `);
  if (!rows[0]) return [];
  return rows[0].values.map(([id, text, embJson, filename]) => ({
    id,
    text,
    embedding: JSON.parse(embJson),
    filename,
  }));
}

async function listDocuments() {
  const db = await getDb();
  const rows = db.exec(`
    SELECT d.id, d.filename, d.created_at, COUNT(c.id) AS chunk_count
    FROM kb_documents d
    LEFT JOIN kb_chunks c ON d.id = c.document_id
    GROUP BY d.id ORDER BY d.created_at DESC
  `);
  if (!rows[0]) return [];
  return rows[0].values.map(([id, filename, created_at, chunk_count]) => ({
    id, filename, created_at, chunk_count,
  }));
}

async function deleteDocument(id) {
  const db = await getDb();
  db.run(`DELETE FROM kb_documents WHERE id = ?`, [id]);
  saveDb();
}

async function documentExistsByHash(hash) {
  const db = await getDb();
  const rows = db.exec(`SELECT id FROM kb_documents WHERE content_hash = ?`, [hash]);
  return rows[0] ? rows[0].values[0][0] : null;
}

// ---- Public API ----

/**
 * Ingest a text document into the KB.
 * Splits into chunks, embeds, and stores.
 * Returns { documentId, chunkCount } or { skipped: true } if already ingested.
 */
async function ingestDocument(text, filename, settings = {}) {
  const contentHash = crypto.createHash('sha256').update(text).digest('hex');

  const existing = await documentExistsByHash(contentHash);
  if (existing) return { skipped: true, documentId: existing };

  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('Document is empty');

  // Embed in batches of 20 (Azure limit per request)
  const BATCH = 20;
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const batchEmbeds = await embedTexts(batch, settings);
    embeddings.push(...batchEmbeds);
  }

  const documentId = await insertDocument(filename, contentHash);
  await insertChunks(documentId, chunks, embeddings);

  return { documentId, chunkCount: chunks.length };
}

/**
 * Query the KB with a natural language question.
 * Returns top-k relevant chunks + an AI-generated answer.
 */
async function queryKb(question, settings = {}, topK = 5) {
  const allChunks = await getAllChunksWithEmbeddings();
  if (allChunks.length === 0) {
    return { answer: 'The knowledge base is empty. Please ingest some documents first.', chunks: [] };
  }

  // Embed the question
  const [questionEmbedding] = await embedTexts([question], settings);

  // Score and rank
  const scored = allChunks
    .map((c) => ({ ...c, score: cosine(questionEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const context = scored
    .map((c, i) => `[${i + 1}] (from ${c.filename})\n${c.text}`)
    .join('\n\n---\n\n');

  // Generate answer using chat LLM
  const { buildClient } = require('./summarizer');
  const { client, model } = buildClient(settings);

  const messages = [
    {
      role: 'system',
      content: `You are a helpful assistant with access to a personal knowledge base.
Answer the user's question based ONLY on the provided context.
If the answer is not in the context, say so clearly.
Cite sources by their [number] when referencing specific content.
The knowledge base may contain meeting transcripts in Hindi, English, or Hinglish — handle all languages naturally.`,
    },
    {
      role: 'user',
      content: `Context from knowledge base:\n\n${context}\n\n---\n\nQuestion: ${question}`,
    },
  ];

  const completion = await client.chat.completions.create({ model, messages, max_tokens: 1000 });
  const answer = completion.choices[0].message.content;

  return {
    answer,
    chunks: scored.map((c) => ({ text: c.text, filename: c.filename, score: Math.round(c.score * 100) / 100 })),
  };
}

module.exports = { ingestDocument, queryKb, listDocuments, deleteDocument };
