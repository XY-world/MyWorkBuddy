import { BaseAgent, AgentContext, AgentOutput, TaskPlan } from './base';
import { buildCodeTools } from '../tools/code-tools';
import { ToolRegistry } from '../tools/copilot-client';
import { getWorkItem } from '../ado/work-items';
import { getConfig } from '../config/manager';

export class PmAgent extends BaseAgent {
  readonly agentKey = 'pm' as const;
  readonly persona = 'Alex';

  readonly soul = `# You are Alex — PM Agent

You are Alex, a meticulous and empathetic project manager with 10 years of experience
shipping enterprise software. You believe that clarity of requirements prevents 90% of
bugs before a line of code is written. You ask "why" before "how". You break work into
the smallest possible atomic tasks — never more than one concern per task. You communicate
in plain, precise language. When requirements are ambiguous, you flag assumptions explicitly
rather than guessing silently. You are the voice of the product owner in this pipeline.`;

  readonly userPerspective = `You represent the **Product Owner / Business** stakeholder.
Your primary concern: Requirements are met and value is delivered.
Your secondary concern: Prevent scope creep — do only what the work item asks.`;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const { session, workItem } = ctx;
    const phase = 'init';

    this.log(session.id, phase, 'info', `PM Agent (${this.persona}) starting analysis of WI#${workItem.id}`);

    // Register tools — PM can explore repo structure
    this.tools = new ToolRegistry();
    for (const t of buildCodeTools(ctx.repoPath)) {
      this.tools.register(t);
    }

    const branchPrefix = getConfig().getAll().ado.branchPrefix || 'feature/';
    const taskInstructions = `
Analyze the following Azure DevOps work item and produce a TaskPlan.

## Work Item #${workItem.id}: ${workItem.title}

**Type:** ${workItem.type}
**State:** ${workItem.state}
**Assigned To:** ${workItem.assignedTo}

**Description:**
${workItem.description || '(no description)'}

**Acceptance Criteria:**
${workItem.acceptanceCriteria || '(no acceptance criteria provided)'}

**Tags:** ${workItem.tags || 'none'}

---

Your output MUST be a single JSON object with this exact shape (no extra text, no markdown, just JSON):

{
  "branchName": "${branchPrefix}wi-${workItem.id}-<short-slug>",
  "prTitle": "[WI#${workItem.id}] <concise title>",
  "prDescription": "<PR description referencing the work item and summarising changes>",
  "tasks": [
    { "seq": 1, "title": "<task title>", "description": "<full instructions for the dev agent>", "agent": "dev" },
    ...
  ]
}

Rules:
- 2–6 tasks maximum
- Each task must have exactly ONE concern
- Task descriptions must be detailed enough for an engineer to implement without asking questions
- Flag assumptions in the description if requirements are ambiguous
- branchName must use exactly the prefix shown above, lowercase with hyphens only, no spaces
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);

    this.log(session.id, phase, 'info', 'Sending work item to PM Agent for analysis');

    let responseText: string;
    try {
      responseText = await this.chat(session.id, systemPrompt, 'Please analyze this work item and produce the TaskPlan JSON.');
    } catch (err: any) {
      this.log(session.id, phase, 'error', `PM Agent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    this.log(session.id, phase, 'decision', 'PM Agent produced TaskPlan', { rawResponse: responseText.slice(0, 500) });

    const plan = this.extractJson<TaskPlan>(responseText);
    if (!plan || !plan.tasks || !Array.isArray(plan.tasks)) {
      const msg = 'PM Agent did not produce valid TaskPlan JSON';
      this.log(session.id, phase, 'error', msg, { response: responseText });
      return { success: false, summary: msg, data: null };
    }

    this.log(session.id, phase, 'decision', `Planned ${plan.tasks.length} tasks, branch: ${plan.branchName}`);

    return {
      success: true,
      summary: `Planned ${plan.tasks.length} tasks. Branch: ${plan.branchName}`,
      data: plan,
      nextPhase: 'planning',
    };
  }
}
