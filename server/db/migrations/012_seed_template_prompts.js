module.exports = {
  id: '012_seed_template_prompts',
  up(db) {
    const prompts = {
      'General': `This is a general meeting. Extract the key information discussed.

## Summary
Provide a concise 3-5 sentence overview of what was discussed, the main topics covered, and the overall outcome.

## Decisions
List all key decisions made during the meeting. If no decisions were made, leave this empty.

## Action Items
List all action items with the responsible person and deadline if mentioned.
Format each as: [Person] - [Task] - [Deadline if known]

## Next Steps
List agreed follow-up actions, open questions, or topics for the next meeting.`,

      'Customer Call': `This is a call with a customer or prospect. Focus on understanding their needs and any commitments made by our team.

## Customer Background
Key details about the customer's business, industry, role, and current situation.

## Pain Points & Needs
Specific challenges, frustrations, or problems the customer expressed. Be precise — use their exact words where possible.

## Feature Requests
Features, capabilities, or improvements the customer explicitly asked for or hinted at.

## Commitments Made
Anything our team promised, committed to deliver, or agreed to follow up on.

## Next Steps
Open questions, follow-up items, or agreed next actions from both sides.`,

      'Product Meeting': `This is a product planning or review meeting. Focus on decisions, priorities, and technical direction.

## Product Decisions
Key product decisions made or confirmed. Note who made or approved each decision.

## Feature Prioritization
Which features were prioritized, deprioritized, cut, or scoped. Include reasoning where mentioned.

## Technical Trade-offs
Technical constraints, risks, architectural choices, or trade-offs discussed.

## Timeline Commitments
Any dates, sprint goals, or milestones committed to. Note who owns each.

## Action Items
Tasks assigned during the meeting. Format: [Person] - [Task] - [Deadline]`,

      'Stand-up': `This is a daily stand-up or team sync. Extract each person's update concisely.

## Yesterday
What each team member completed or worked on. Group by person.

## Today
What each team member plans to work on today. Group by person.

## Blockers
Any blockers, impediments, or help needed raised by the team. Note who raised each blocker.`,
    };

    for (const [name, prompt] of Object.entries(prompts)) {
      db.run(
        "UPDATE summary_templates SET prompt = ? WHERE name = ? AND (prompt IS NULL OR prompt = '' OR created_by_name = 'System')",
        [prompt, name]
      );
    }
  },
};
