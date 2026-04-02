import { BaseAgent, AgentContext, AgentOutput, ReviewResult } from './base';
import { getFullDiff } from '../tools/git-tools';

export class ReviewAgent extends BaseAgent {
  readonly agentKey = 'review' as const;
  readonly persona = 'Jordan';

  readonly soul = `# You are Jordan — Review Agent

You are Jordan, a principled tech lead who cares deeply about long-term maintainability.
You review code as if you will be the one maintaining it for the next 5 years. You look
for correctness first, security second, readability third. You give specific, actionable
feedback — never vague criticism. You acknowledge what was done well before listing issues.
A score of 8+ means production-ready with minor notes. You are the quality gate of this
pipeline.`;

  readonly userPerspective = `You represent the **Tech Lead / Architect** stakeholder.
Your primary concern: Maintainability and security of the codebase.
Your secondary concern: Adherence to team standards and conventions.`;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const { session, workItem } = ctx;
    const phase = 'review';

    this.log(session.id, phase, 'info', `Review Agent (${this.persona}) starting code review`);

    // Get full diff
    let diff = '';
    try {
      diff = getFullDiff(ctx.repoPath);
    } catch (err: any) {
      this.log(session.id, phase, 'error', `Could not get diff: ${err.message}`);
    }

    if (!diff.trim()) {
      this.log(session.id, phase, 'info', 'No diff found — auto-approving (nothing to review)');
      const result: ReviewResult = {
        approved: true,
        overallScore: 10,
        comments: [],
        requestedChanges: [],
      };
      return { success: true, summary: 'No changes to review', data: result };
    }

    const devSummaries = (ctx.previousOutputs.dev ?? [])
      .map((cs, i) => `Task ${i + 1}: ${cs.summary} (files: ${cs.filesModified.join(', ')})`)
      .join('\n');

    const taskInstructions = `
Review the following code changes for Work Item #${workItem.id}: ${workItem.title}

## Work Item Requirements
**Description:** ${workItem.description || '(none)'}
**Acceptance Criteria:** ${workItem.acceptanceCriteria || '(none)'}

## Tasks Completed by Dev Agent
${devSummaries || '(no summaries available)'}

## Full Git Diff
\`\`\`diff
${diff.slice(0, 20000)}${diff.length > 20000 ? '\n... (diff truncated)' : ''}
\`\`\`

---

Review the implementation against the acceptance criteria. Evaluate:
1. **Correctness** — Does the code satisfy the requirements?
2. **Quality** — Are patterns, naming, and style consistent with the rest of the codebase?
3. **Security** — Any injection, auth bypass, secrets in code, or obvious vulnerabilities?
4. **Completeness** — Missing tests, missing error handling, missing edge cases?

Score 1–10. Set approved=true if score >= 7 and no blocking issues.

Respond with ONLY this JSON (no other text):
{
  "approved": true|false,
  "overallScore": <number 1-10>,
  "comments": [
    { "file": "<path>", "line": <optional line number>, "comment": "<actionable comment>" }
  ],
  "requestedChanges": [
    "<specific change required before approval>"
  ]
}
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);

    this.log(session.id, phase, 'info', `Reviewing diff (${diff.length} chars)`);

    let responseText: string;
    try {
      responseText = await this.chat(session.id, systemPrompt, 'Please review the code changes.');
    } catch (err: any) {
      this.log(session.id, phase, 'error', `Review Agent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    const result = this.extractJson<ReviewResult>(responseText);
    if (!result) {
      this.log(session.id, phase, 'error', 'Review Agent did not return valid JSON', { response: responseText });
      return { success: false, summary: 'Review Agent returned invalid response', data: null };
    }

    const verdict = result.approved ? `APPROVED (score: ${result.overallScore}/10)` : `CHANGES REQUESTED (score: ${result.overallScore}/10)`;
    this.log(session.id, phase, 'decision', verdict, { result });

    return {
      success: true,
      summary: `${verdict}. ${result.comments.length} comments, ${result.requestedChanges.length} required changes.`,
      data: result,
      newMemories: result.approved
        ? result.comments.map((c) => ({
            type: 'lesson_learned' as const,
            key: `review_note_${Date.now()}`,
            value: `${c.file}: ${c.comment}`,
            confidence: 0.7,
          }))
        : undefined,
    };
  }
}
