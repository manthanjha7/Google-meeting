const { randomUUID } = require('crypto');

module.exports = {
  id: '009_seed_default_templates',
  up(db) {
    const defaults = [
      {
        name: 'General',
        meeting_context: 'A general meeting. Capture the key discussion points, decisions made, and next steps agreed upon.',
        sections: [
          { title: 'Summary', prompt: 'A concise 3-5 sentence overview of what was discussed.' },
          { title: 'Decisions', prompt: 'Key decisions made during the meeting.' },
          { title: 'Action Items', prompt: 'Tasks assigned, with owner and deadline if mentioned.' },
          { title: 'Next Steps', prompt: 'Agreed follow-up actions or next meeting topics.' },
        ],
      },
      {
        name: 'Customer Call',
        meeting_context: 'A call with a customer or prospect. Focus on their needs, concerns, and any commitments made by our team.',
        sections: [
          { title: 'Customer Pain Points', prompt: 'Specific challenges and problems the customer expressed.' },
          { title: 'Feature Requests', prompt: 'Features or capabilities the customer asked for or hinted at.' },
          { title: 'Commitments Made', prompt: 'Anything our team promised or committed to deliver.' },
          { title: 'Satisfaction Signals', prompt: 'Positive or negative signals about customer satisfaction.' },
          { title: 'Follow-ups', prompt: 'Topics or questions needing follow-up after the call.' },
        ],
      },
      {
        name: 'Product Meeting',
        meeting_context: 'A product planning or review meeting. Focus on decisions, priorities, and technical trade-offs.',
        sections: [
          { title: 'Product Decisions', prompt: 'Key product decisions made or confirmed.' },
          { title: 'Feature Prioritization', prompt: 'Which features were prioritized, deprioritized, or scoped.' },
          { title: 'Technical Trade-offs', prompt: 'Technical constraints or trade-offs discussed.' },
          { title: 'Timeline Commitments', prompt: 'Any dates or sprints committed to.' },
          { title: 'Action Items', prompt: 'Tasks assigned, grouped by feature area if possible.' },
        ],
      },
      {
        name: 'Stand-up',
        meeting_context: 'A daily stand-up or sync meeting. Focus on what each person did, plans for today, and any blockers.',
        sections: [
          { title: 'Yesterday', prompt: 'What each person completed or worked on yesterday.' },
          { title: 'Today', prompt: 'What each person plans to do today.' },
          { title: 'Blockers', prompt: 'Any blockers or impediments raised by the team.' },
        ],
      },
    ];

    for (const tmpl of defaults) {
      const templateId = randomUUID();
      db.run(
        'INSERT INTO summary_templates (id, name, meeting_context) VALUES (?, ?, ?)',
        [templateId, tmpl.name, tmpl.meeting_context]
      );
      tmpl.sections.forEach((sec, i) => {
        db.run(
          'INSERT INTO template_sections (id, template_id, title, prompt, position) VALUES (?, ?, ?, ?, ?)',
          [randomUUID(), templateId, sec.title, sec.prompt, i]
        );
      });
    }
  },
};
