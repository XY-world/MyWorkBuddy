import { BaseAgent, AgentContext, AgentOutput, WorkItemAnalysis } from './base';
import { buildCodeTools } from '../tools/code-tools';
import { ToolRegistry } from '../tools/copilot-client';

/**
 * WorkItemReviewAgent (Persona: Riley)
 *
 * First agent in the pipeline. Analyses the work item before any code is written:
 * - Validates that requirements are clear enough to implement
 * - Assesses technical feasibility given the existing codebase
 * - Identifies risks, dependencies, and potential blockers
 * - Enriches context that the planning agent will use
 *
 * If the WI is deemed infeasible (e.g. missing requirements, contradictory criteria),
 * the pipeline is paused and a comment is added to the ADO work item.
 */
export class WorkItemReviewAgent extends BaseAgent {
  readonly agentKey = 'wi_review' as const;
  readonly persona = 'Riley';

  readonly soul = `# You are Riley — Work Item Review Agent

You are Riley, a pragmatic principal engineer who has seen what happens when vague
requirements reach development: wasted sprints, scope creep, and frustrated teams.
You review work items before a single line of code is written. You ask: "Can an engineer
implement this without guessing?" You flag missing acceptance criteria, contradictory
requirements, and hidden dependencies. You also assess whether the existing codebase
can realistically support the requested change. You are the gate between a stakeholder's
wish and a working implementation.`;

  readonly userPerspective = `You represent the **Principal Engineer / Architect** stakeholder.
Your primary concern: Requirements are actionable and technically feasible.
Your secondary concern: Identify risks early so the team can mitigate them before development starts.`;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const { session, workItem } = ctx;
    const phase = 'wi_review';

    this.log(session.id, phase, 'info', `WorkItemReviewAgent (${this.persona}) starting review of WI#${workItem.id}`);

    // Allow Riley to inspect the repo structure for feasibility assessment
    this.tools = new ToolRegistry();
    for (const t of buildCodeTools(ctx.repoPath)) {
      this.tools.register(t);
    }
    this.registerMcpTools();

    const taskInstructions = `
Review the following Azure DevOps work item and produce a WorkItemAnalysis.

## Work Item #${workItem.id}: ${workItem.title}

**Type:** ${workItem.type}
**State:** ${workItem.state}
**Assigned To:** ${workItem.assignedTo}
**Story Points:** ${workItem.storyPoints ?? 'not set'}
**Iteration:** ${workItem.iterationPath}

**Description:**
${workItem.description || '(no description provided)'}

**Acceptance Criteria:**
${workItem.acceptanceCriteria || '(no acceptance criteria provided)'}

**Tags:** ${workItem.tags || 'none'}

---

Use the available tools to:
1. Explore the repository structure to understand the codebase context
2. Look for existing patterns relevant to this work item
3. Identify technical dependencies

Then produce a WorkItemAnalysis JSON:

{
  "feasible": true|false,
  "complexity": "low"|"medium"|"high",
  "risks": ["<risk 1>", "<risk 2>"],
  "enrichedNotes": "<key context, assumptions, and implementation hints for the planning agent>",
  "blockers": ["<blocker if feasible=false, else empty array>"]
}

Rules:
- DEFAULT to feasible=true — only set feasible=false as a last resort
- The ONLY valid reasons to set feasible=false: (1) the work item has no title AND no description whatsoever, OR (2) the requirements directly contradict each other (e.g. "must be synchronous" AND "must be async")
- Everything else — missing AC, linked docs you cannot access, unclear scope, missing specs, unknown permissions, high complexity — are RISKS, not blockers
- Inaccessible or unreadable linked documents are a RISK, not a blocker — make assumptions based on the title and description
- Missing acceptance criteria is a RISK, not a blocker
- If you can make ANY reasonable interpretation of the work item, set feasible=true and document your assumptions in enrichedNotes
- risks are concerns that could cause problems but don't prevent starting
- blockers array must be EMPTY when feasible=true
- enrichedNotes should contain observations about the codebase that will help the planning agent write better tasks
- complexity: low = 1-2 files, trivial change; medium = multiple modules, some design needed; high = cross-cutting concern, significant refactor
- When in doubt, set feasible=true — the developer can always override
- Respond with ONLY the JSON object, no other text
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);

    this.log(session.id, phase, 'info', 'Sending work item to WorkItemReviewAgent for feasibility analysis');

    let responseText: string;
    try {
      responseText = await this.chatWithTools(
        session.id,
        systemPrompt,
        'Please review this work item and produce the WorkItemAnalysis JSON.',
        8,
      );
    } catch (err: any) {
      this.log(session.id, phase, 'error', `WorkItemReviewAgent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    const analysis = this.extractJson<WorkItemAnalysis>(responseText);
    if (!analysis || typeof analysis.feasible !== 'boolean') {
      const msg = 'WorkItemReviewAgent did not return valid WorkItemAnalysis JSON';
      this.log(session.id, phase, 'error', msg, { response: responseText });
      return { success: false, summary: msg, data: null };
    }

    const verdict = analysis.feasible
      ? `FEASIBLE (${analysis.complexity} complexity)`
      : `NOT FEASIBLE — ${analysis.blockers.length} blocker(s)`;
    this.log(session.id, phase, 'decision', verdict, { analysis });

    return {
      success: true,
      summary: `${verdict}. Risks: ${analysis.risks.length}. ${analysis.feasible ? '' : 'Blockers: ' + analysis.blockers.join('; ')}`,
      data: analysis,
      nextPhase: analysis.feasible ? 'init' : undefined,
    };
  }

  /**
   * Follow-up Q&A after the initial analysis. Riley answers questions about the
   * work item in plain text (no JSON). Called when the user types in the chat panel.
   */
  async followUp(ctx: AgentContext, userMessage: string, analysis: WorkItemAnalysis): Promise<string> {
    const { session, workItem } = ctx;

    const systemPrompt = `${this.soul}

You have already reviewed Work Item #${workItem.id}: "${workItem.title}".

Your analysis:
- Feasible: ${analysis.feasible} (${analysis.complexity} complexity)
- Risks: ${analysis.risks.join('; ') || 'none'}
- Enriched notes: ${analysis.enrichedNotes}
${analysis.blockers.length > 0 ? `- Blockers: ${analysis.blockers.join('; ')}` : ''}

The developer has a follow-up question. Answer concisely and helpfully.
Do NOT produce JSON — respond in plain conversational text.`;

    try {
      return await this.chat(session.id, systemPrompt, userMessage);
    } catch (err: any) {
      return `Sorry, I couldn't process that: ${err.message}`;
    }
  }
}
