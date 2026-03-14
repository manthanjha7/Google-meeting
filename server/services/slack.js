/**
 * Post a formatted meeting summary to Slack via incoming webhook.
 */
async function postToSlack(summary, callType) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not configured');

  const callTypeLabels = {
    internal: 'Internal',
    customer: 'Customer',
    gtm: 'GTM',
    product: 'Product',
  };

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: summary.title || 'Meeting Summary',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Call Type:* ${callTypeLabels[callType] || callType} | *Date:* ${new Date().toLocaleDateString('en-IN', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  // Participants
  if (summary.participants && summary.participants.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Participants:* ${summary.participants.join(', ')}`,
      },
    });
  }

  // Summary
  if (summary.summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary*\n${summary.summary}`,
      },
    });
  }

  // Decisions
  if (summary.decisions && summary.decisions.length > 0) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Key Decisions*\n${summary.decisions.map((d) => `• ${d}`).join('\n')}`,
        },
      }
    );
  }

  // Action Items
  if (summary.actionItems && summary.actionItems.length > 0) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Action Items*\n${summary.actionItems.map((a) => `• ${a}`).join('\n')}`,
        },
      }
    );
  }

  // Follow-ups
  if (summary.followUps && summary.followUps.length > 0) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Follow-ups*\n${summary.followUps.map((f) => `• ${f}`).join('\n')}`,
        },
      }
    );
  }

  const payload = {
    blocks,
    text: `Meeting Summary: ${summary.title || 'Untitled'}`, // Fallback text
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${errorText}`);
  }

  return true;
}

module.exports = { postToSlack };
