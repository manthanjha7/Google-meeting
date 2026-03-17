const Anthropic = require('@anthropic-ai/sdk');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

// ---- Transcript Chunking ----

const MAX_CHUNK_TOKENS = 12000;    // ~12k tokens per chunk (safe for Claude context)
const OVERLAP_TOKENS = 500;        // Overlap between chunks to preserve context
const CHARS_PER_TOKEN = 4;         // Rough approximation

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split transcript into overlapping chunks for summarization.
 * Each chunk stays under MAX_CHUNK_TOKENS. Splits on line boundaries
 * to avoid breaking mid-sentence.
 */
function chunkTranscript(transcript) {
  const totalTokens = estimateTokens(transcript);
  if (totalTokens <= MAX_CHUNK_TOKENS) {
    return [transcript];
  }

  const lines = transcript.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  const maxCharsPerChunk = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));

      // Keep overlap: take the last N characters worth of lines
      const fullText = currentChunk.join('\n');
      const overlapText = fullText.slice(-overlapChars);
      const overlapLines = overlapText.split('\n');
      // Start new chunk with overlap lines (skip first partial line)
      currentChunk = overlapLines.length > 1 ? overlapLines.slice(1) : [];
      currentTokens = estimateTokens(currentChunk.join('\n'));
    }
    currentChunk.push(line);
    currentTokens += lineTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  return chunks;
}

// ---- Prompts ----

const SUMMARY_PROMPT = `You are a meeting intelligence assistant for the Finrep team. Analyze the following meeting transcript and produce a structured summary.

The transcript may contain Hindi-English code-switched language. Process it naturally regardless of language.

Return your response as a JSON object with exactly these fields:
{
  "title": "A concise, descriptive title for the meeting (max 10 words)",
  "participants": ["List of participant names mentioned in the transcript, or empty array if none identified"],
  "summary": "A 3-5 sentence overview of what was discussed",
  "decisions": ["Each key decision made during the meeting, as a separate item"],
  "actionItems": ["Each action item in format: '[Person if known] - Task description - [Deadline if mentioned]'"],
  "followUps": ["Topics or meetings that need follow-up"],
  "deadlines": ["Each deadline mentioned in format: '[Task] - [Date/Timeframe]'"],
  "nextSteps": ["Agreed next steps or follow-up meetings"]
}

Rules:
- Be concise but capture all important information
- If the transcript is in Hindi-English, produce the summary in English
- If no decisions were made, return an empty array for decisions
- If no action items were identified, return an empty array for actionItems
- Always return valid JSON

TRANSCRIPT:
`;

const CHUNK_SUMMARY_PROMPT = `You are a meeting intelligence assistant. Summarize this portion of a meeting transcript into key points.

Return a JSON object with these fields:
{
  "keyPoints": ["Important points discussed in this segment"],
  "decisions": ["Any decisions made"],
  "actionItems": ["Action items mentioned"],
  "participants": ["Names mentioned"],
  "deadlines": ["Deadlines mentioned"],
  "context": "1-2 sentences of context about what's being discussed"
}

Always return valid JSON. This is chunk CHUNK_NUM of TOTAL_CHUNKS.

TRANSCRIPT SEGMENT:
`;

const MERGE_PROMPT = `You are a meeting intelligence assistant for the Finrep team. You've been given summaries of different segments of the same meeting. Merge them into one cohesive meeting summary.

Return your response as a JSON object with exactly these fields:
{
  "title": "A concise, descriptive title for the meeting (max 10 words)",
  "participants": ["Deduplicated list of all participant names"],
  "summary": "A 3-5 sentence overview of the entire meeting",
  "decisions": ["All key decisions, deduplicated"],
  "actionItems": ["All action items in format: '[Person] - Task - [Deadline]', deduplicated"],
  "followUps": ["All follow-up topics, deduplicated"],
  "deadlines": ["All deadlines mentioned, deduplicated"],
  "nextSteps": ["All next steps, deduplicated"]
}

Rules:
- Merge and deduplicate information across segments
- Maintain chronological context
- Be concise but comprehensive
- Always return valid JSON

SEGMENT SUMMARIES:
`;

/**
 * Summarize a meeting transcript using Claude.
 * Automatically chunks long transcripts for reliable processing.
 * @param {string} transcript
 * @param {string} extraInstructions - Additional instructions from template or custom prompt
 */
async function summarize(transcript, extraInstructions = '') {
  if (!transcript || transcript.trim().length === 0) {
    return {
      title: 'Empty Meeting',
      participants: [],
      summary: 'No transcript content was available for summarization.',
      decisions: [],
      actionItems: [],
      followUps: [],
      deadlines: [],
      nextSteps: [],
    };
  }

  const chunks = chunkTranscript(transcript);

  if (chunks.length === 1) {
    return await summarizeSingle(chunks[0], extraInstructions);
  }

  console.log(`[Summarizer] Transcript too long for single pass, using ${chunks.length} chunks with overlap`);
  return await summarizeChunked(chunks, extraInstructions);
}

/**
 * Stream a summary using SSE. Only supports single-pass (short transcripts get chunked internally).
 * @param {string} transcript
 * @param {string} extraInstructions
 * @param {function} onChunk - callback(textChunk)
 */
async function summarizeStream(transcript, extraInstructions = '', onChunk) {
  const anthropic = getClient();
  const prompt = buildPrompt(SUMMARY_PROMPT, extraInstructions) + transcript;

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      onChunk(event.delta.text);
    }
  }
}

/**
 * Build prompt with optional extra instructions.
 */
function buildPrompt(basePrompt, extraInstructions = '') {
  if (!extraInstructions) return basePrompt;
  return basePrompt + `\n\nADDITIONAL INSTRUCTIONS:\n${extraInstructions}\n\nTRANSCRIPT:\n`;
}

/**
 * Single-pass summarization for shorter transcripts.
 */
async function summarizeSingle(transcript, extraInstructions = '') {
  const anthropic = getClient();
  const prompt = extraInstructions
    ? buildPrompt(SUMMARY_PROMPT.replace(/\nTRANSCRIPT:\n$/, ''), extraInstructions)
    : SUMMARY_PROMPT;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: prompt + transcript,
      },
    ],
  });

  return parseSummaryResponse(message.content[0].text);
}

/**
 * Multi-chunk summarization: summarize each chunk, then merge.
 */
async function summarizeChunked(chunks, extraInstructions = '') {
  const anthropic = getClient();

  // Step 1: Summarize each chunk
  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Summarizer] Processing chunk ${i + 1}/${chunks.length} (${estimateTokens(chunks[i])} tokens)`);

    const prompt = CHUNK_SUMMARY_PROMPT
      .replace('CHUNK_NUM', String(i + 1))
      .replace('TOTAL_CHUNKS', String(chunks.length));

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: prompt + chunks[i],
        },
      ],
    });

    chunkSummaries.push(message.content[0].text);
  }

  // Step 2: Merge chunk summaries into final summary
  console.log(`[Summarizer] Merging ${chunkSummaries.length} chunk summaries`);

  const mergeInput = chunkSummaries
    .map((s, i) => `--- Segment ${i + 1} ---\n${s}`)
    .join('\n\n');

  const mergeMessage = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: MERGE_PROMPT + mergeInput,
      },
    ],
  });

  return parseSummaryResponse(mergeMessage.content[0].text);
}

/**
 * Parse Claude's response into a structured summary object.
 */
function parseSummaryResponse(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse summary JSON from Claude response');
  }

  const summary = JSON.parse(jsonMatch[0]);

  // Validate and fill required fields
  const arrayFields = ['decisions', 'actionItems', 'followUps', 'deadlines', 'nextSteps', 'participants'];
  const stringFields = ['title', 'summary'];

  for (const field of stringFields) {
    if (!(field in summary)) summary[field] = '';
  }
  for (const field of arrayFields) {
    if (!(field in summary) || !Array.isArray(summary[field])) summary[field] = [];
  }

  return summary;
}

module.exports = { summarize, summarizeStream, chunkTranscript };
