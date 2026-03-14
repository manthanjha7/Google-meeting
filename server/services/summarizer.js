const Anthropic = require('@anthropic-ai/sdk');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const SUMMARY_PROMPT = `You are a meeting intelligence assistant for the Finrep team. Analyze the following meeting transcript and produce a structured summary.

The transcript may contain Hindi-English code-switched language. Process it naturally regardless of language.

Return your response as a JSON object with exactly these fields:
{
  "title": "A concise, descriptive title for the meeting (max 10 words)",
  "participants": ["List of participant names mentioned in the transcript, or empty array if none identified"],
  "summary": "A 3-5 sentence overview of what was discussed",
  "decisions": ["Each key decision made during the meeting, as a separate item"],
  "actionItems": ["Each action item in format: '[Person if known] - Task description - [Deadline if mentioned]'"],
  "followUps": ["Topics or meetings that need follow-up"]
}

Rules:
- Be concise but capture all important information
- If the transcript is in Hindi-English, produce the summary in English
- If no decisions were made, return an empty array for decisions
- If no action items were identified, return an empty array for actionItems
- Always return valid JSON

TRANSCRIPT:
`;

/**
 * Summarize a meeting transcript using Claude.
 */
async function summarize(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    return {
      title: 'Empty Meeting',
      participants: [],
      summary: 'No transcript content was available for summarization.',
      decisions: [],
      actionItems: [],
      followUps: [],
    };
  }

  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: SUMMARY_PROMPT + transcript,
      },
    ],
  });

  const responseText = message.content[0].text;

  // Extract JSON from the response (handle markdown code blocks)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse summary JSON from Claude response');
  }

  const summary = JSON.parse(jsonMatch[0]);

  // Validate required fields
  const requiredFields = ['title', 'summary', 'decisions', 'actionItems', 'followUps'];
  for (const field of requiredFields) {
    if (!(field in summary)) {
      summary[field] = field === 'title' || field === 'summary' ? '' : [];
    }
  }
  if (!summary.participants) summary.participants = [];

  return summary;
}

module.exports = { summarize };
