const { AzureOpenAI } = require('openai');

// ---- Client ----

let client;

function getClient() {
  if (!client) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

    if (!endpoint || !apiKey) {
      throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set');
    }

    client = new AzureOpenAI({ endpoint, apiKey, apiVersion });
  }
  return client;
}

function getDeployment() {
  return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
}

// ---- Transcript Chunking ----

const MAX_CHUNK_TOKENS = 12000;
const OVERLAP_TOKENS = 500;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function chunkTranscript(transcript) {
  const totalTokens = estimateTokens(transcript);
  if (totalTokens <= MAX_CHUNK_TOKENS) {
    return [transcript];
  }

  const lines = transcript.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));

      const fullText = currentChunk.join('\n');
      const overlapText = fullText.slice(-overlapChars);
      const overlapLines = overlapText.split('\n');
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

const SUMMARY_PROMPT = `You are a meeting intelligence assistant for the Finrep team.

IMPORTANT: The transcript may contain Hindi, English, or Hinglish (Hindi-English code-switching mid-sentence).
Examples of Hinglish you will encounter: "yeh issue fix karna hai", "kya hum Friday tak deliver kar sakte hain?", "client ne bola ki budget tight hai".
Process all languages naturally. Always produce your output in English.
Preserve Hindi/Hinglish proper nouns (names, places, product names) as-is.

Analyze the transcript and return a JSON object with exactly these fields:
{
  "title": "A concise, descriptive title for the meeting (max 10 words, in English)",
  "participants": ["List of participant names mentioned or addressed in the transcript. Look for direct address: 'Thanks Rahul', 'Priya can you...', 'Amit ne bola'. Return empty array if none found."],
  "summary": "A 3-5 sentence overview of what was discussed, in English",
  "decisions": ["Each key decision made, in English. Empty array if none."],
  "actionItems": ["Each action item: '[Person if known] - Task description - [Deadline if mentioned]'. In English."],
  "followUps": ["Topics or items needing follow-up, in English"],
  "deadlines": ["Each deadline: '[Task] - [Date/Timeframe]', in English"],
  "nextSteps": ["Agreed next steps or follow-up meetings, in English"]
}

Rules:
- If a speaker says something in Hinglish like "hum isko next sprint mein lenge", translate the intent: "Taking this up in next sprint"
- If no decisions were made, return empty array for decisions
- Always return valid JSON, nothing else

TRANSCRIPT:
`;

const CHUNK_SUMMARY_PROMPT = `You are a meeting intelligence assistant. Summarize this segment of a meeting transcript.

IMPORTANT: The transcript may contain Hindi, English, or Hinglish (code-switched). Process all languages naturally. Output in English only.
Hinglish examples: "yeh blocker hai", "kab tak hoga?", "client chahta hai ki..."

Return a JSON object with these fields:
{
  "keyPoints": ["Important points discussed in this segment, in English"],
  "decisions": ["Any decisions made, in English"],
  "actionItems": ["Action items mentioned, in English"],
  "participants": ["Names mentioned or directly addressed in this segment"],
  "deadlines": ["Deadlines mentioned, in English"],
  "context": "1-2 sentences of context about what is being discussed, in English"
}

Always return valid JSON. This is chunk CHUNK_NUM of TOTAL_CHUNKS.

TRANSCRIPT SEGMENT:
`;

const MERGE_PROMPT = `You are a meeting intelligence assistant for the Finrep team. Merge these segment summaries from the same meeting into one cohesive summary.

Return a JSON object with exactly these fields:
{
  "title": "A concise, descriptive title for the meeting (max 10 words, in English)",
  "participants": ["Deduplicated list of all participant names across all segments"],
  "summary": "A 3-5 sentence overview of the entire meeting, in English",
  "decisions": ["All key decisions, deduplicated, in English"],
  "actionItems": ["All action items: '[Person] - Task - [Deadline]', deduplicated, in English"],
  "followUps": ["All follow-up topics, deduplicated, in English"],
  "deadlines": ["All deadlines, deduplicated, in English"],
  "nextSteps": ["All next steps, deduplicated, in English"]
}

Rules:
- Merge and deduplicate information across segments
- Maintain chronological context
- Always return valid JSON, nothing else

SEGMENT SUMMARIES:
`;

const SPEAKER_DETECTION_PROMPT = `You are analyzing a meeting transcript to identify who is speaking as SPEAKER_0, SPEAKER_1, etc.

Look for moments where speakers are directly addressed by name:
- "Thanks Rahul, ..." → the previous speaker might be Rahul, or Rahul is being thanked
- "Priya, can you take this?" → SPEAKER addressing someone named Priya
- "Amit ne bola ki..." → Amit said something
- "Okay [Name], I agree" → Name is being addressed

Return a JSON object mapping speaker IDs to names. Only include mappings you are confident about.
Example: {"SPEAKER_0": "Rahul", "SPEAKER_1": "Priya"}

If you cannot confidently identify a speaker, omit them from the mapping.
Return empty object {} if no names can be identified.

Return only valid JSON, nothing else.

TRANSCRIPT:
`;

// ---- Public API ----

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

  console.log(`[Summarizer] Long transcript, using ${chunks.length} chunks with overlap`);
  return await summarizeChunked(chunks, extraInstructions);
}

async function summarizeStream(transcript, extraInstructions = '', onChunk) {
  const az = getClient();
  const prompt = buildPrompt(SUMMARY_PROMPT, extraInstructions) + transcript;

  const stream = await az.chat.completions.create({
    model: getDeployment(),
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) onChunk(text);
  }
}

async function detectSpeakerNames(transcript) {
  try {
    const az = getClient();
    const response = await az.chat.completions.create({
      model: getDeployment(),
      max_tokens: 256,
      messages: [{ role: 'user', content: SPEAKER_DETECTION_PROMPT + transcript }],
    });

    const raw = response.choices[0].message.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn('[Summarizer] Speaker detection failed:', err.message);
    return {};
  }
}

// ---- Internals ----

function buildPrompt(basePrompt, extraInstructions = '') {
  if (!extraInstructions) return basePrompt;
  return basePrompt + `\n\nADDITIONAL INSTRUCTIONS:\n${extraInstructions}\n\nTRANSCRIPT:\n`;
}

async function summarizeSingle(transcript, extraInstructions = '') {
  const az = getClient();
  const prompt = extraInstructions
    ? buildPrompt(SUMMARY_PROMPT.replace(/\nTRANSCRIPT:\n$/, ''), extraInstructions)
    : SUMMARY_PROMPT;

  const response = await az.chat.completions.create({
    model: getDeployment(),
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt + transcript }],
  });

  return parseSummaryResponse(response.choices[0].message.content);
}

async function summarizeChunked(chunks, extraInstructions = '') {
  const az = getClient();
  const chunkSummaries = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Summarizer] Processing chunk ${i + 1}/${chunks.length} (~${estimateTokens(chunks[i])} tokens)`);

    const prompt = CHUNK_SUMMARY_PROMPT
      .replace('CHUNK_NUM', String(i + 1))
      .replace('TOTAL_CHUNKS', String(chunks.length));

    const response = await az.chat.completions.create({
      model: getDeployment(),
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt + chunks[i] }],
    });

    chunkSummaries.push(response.choices[0].message.content);
  }

  console.log(`[Summarizer] Merging ${chunkSummaries.length} chunk summaries`);

  const mergeInput = chunkSummaries
    .map((s, i) => `--- Segment ${i + 1} ---\n${s}`)
    .join('\n\n');

  const mergeResponse = await az.chat.completions.create({
    model: getDeployment(),
    max_tokens: 4096,
    messages: [{ role: 'user', content: MERGE_PROMPT + mergeInput }],
  });

  return parseSummaryResponse(mergeResponse.choices[0].message.content);
}

function parseSummaryResponse(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse summary JSON from LLM response');
  }

  const summary = JSON.parse(jsonMatch[0]);

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

module.exports = { summarize, summarizeStream, detectSpeakerNames, chunkTranscript };
