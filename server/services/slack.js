/**
 * Slack integration service.
 *
 * Two modes:
 *  1. Bot token (preferred) — uses chat.postMessage Web API with thread replies.
 *     Requires SLACK_BOT_TOKEN + SLACK_CHANNEL_ID (or set via dashboard settings).
 *  2. Incoming webhook (fallback) — single-message post via SLACK_WEBHOOK_URL.
 *     No thread support; used when bot token is not configured.
 */

const SLACK_API = 'https://slack.com/api';

// ---- Shared block builders ----

function callTypeLabel(callType) {
  return { internal: 'Internal', customer: 'Customer', gtm: 'GTM', product: 'Product' }[callType] || callType;
}

function buildHeaderBlocks(summary, callType) {
  const date = new Date().toLocaleDateString('en-IN', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: summary.title || 'Meeting Summary', emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*Call Type:* ${callTypeLabel(callType)} | *Date:* ${date}`,
      }],
    },
    { type: 'divider' },
  ];

  if (summary.participants?.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Participants:* ${summary.participants.join(', ')}` },
    });
  }

  if (summary.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary*\n${summary.summary}` },
    });
  }

  return blocks;
}

// ---- Bot token API (thread-based) ----

async function slackApiCall(method, token, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (${method}): ${data.error}`);
  return data;
}

async function postToSlackThread(summary, callType, settings = {}) {
  const token = settings.slack_bot_token || process.env.SLACK_BOT_TOKEN;
  const channel = settings.slack_channel_id || process.env.SLACK_CHANNEL_ID;
  if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
  if (!channel) throw new Error('SLACK_CHANNEL_ID not configured');

  // 1. Post main message — title + summary + participants
  const mainData = await slackApiCall('chat.postMessage', token, {
    channel,
    blocks: buildHeaderBlocks(summary, callType),
    text: `Meeting Summary: ${summary.title || 'Untitled'}`,
  });
  const threadTs = mainData.ts;

  // 2. Thread reply: Key Decisions
  if (summary.decisions?.length) {
    await slackApiCall('chat.postMessage', token, {
      channel,
      thread_ts: threadTs,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Key Decisions*\n${summary.decisions.map((d) => `• ${d}`).join('\n')}`,
        },
      }],
      text: 'Key Decisions',
    });
  }

  // 3. Thread reply: Action Items
  if (summary.actionItems?.length) {
    await slackApiCall('chat.postMessage', token, {
      channel,
      thread_ts: threadTs,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Action Items*\n${summary.actionItems.map((a) => `☐ ${a}`).join('\n')}`,
        },
      }],
      text: 'Action Items',
    });
  }

  // 4. Thread reply: Follow-ups / Next Steps (combined if both present)
  const followUpItems = [
    ...(summary.followUps || []).map((f) => `• ${f}`),
    ...(summary.nextSteps || []).map((n) => `→ ${n}`),
    ...(summary.deadlines || []).map((d) => `⏰ ${d}`),
  ];
  if (followUpItems.length) {
    await slackApiCall('chat.postMessage', token, {
      channel,
      thread_ts: threadTs,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Follow-ups & Next Steps*\n${followUpItems.join('\n')}`,
        },
      }],
      text: 'Follow-ups & Next Steps',
    });
  }

  return { threadTs, channel };
}

// ---- Webhook (fallback, single message) ----

async function postToSlack(summary, callType) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not configured');

  const blocks = buildHeaderBlocks(summary, callType);

  if (summary.decisions?.length) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Key Decisions*\n${summary.decisions.map((d) => `• ${d}`).join('\n')}` } }
    );
  }
  if (summary.actionItems?.length) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Action Items*\n${summary.actionItems.map((a) => `• ${a}`).join('\n')}` } }
    );
  }
  if (summary.followUps?.length) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Follow-ups*\n${summary.followUps.map((f) => `• ${f}`).join('\n')}` } }
    );
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks, text: `Meeting Summary: ${summary.title || 'Untitled'}` }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed (${response.status}): ${await response.text()}`);
  }
  return true;
}

module.exports = { postToSlack, postToSlackThread };
