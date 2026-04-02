import { BaseAgent, AgentContext, AgentOutput } from './base';
import { ToolRegistry, ToolDefinition } from '../tools/copilot-client';
import { buildCodeTools } from '../tools/code-tools';
import { buildAdoTools } from '../tools/ado-tools';
import { StageDefinition } from './pipeline-types';

export interface InvestigationResult {
  summary: string;
  findings: string[];
  recommendations: string[];
  adoComment: string;   // formatted markdown comment to post on the WI
}

export class InvestigationAgent extends BaseAgent {
  readonly agentKey = 'dev' as const;   // reuse dev slot in memory
  readonly persona = 'Alex';
  readonly soul = `# You are Alex — Investigation Agent

You are Alex, a senior engineer who investigates technical questions, analyses data,
and synthesises findings into clear, actionable summaries. You are rigorous: you show
your work, cite sources, and distinguish between confirmed facts and assumptions.
You do not guess — if you cannot find data, you say so explicitly.`;

  readonly userPerspective = `You represent the **Senior Engineer / Researcher** stakeholder.
Your job is to answer the question posed by the work item using the tools available.
Deliver clear findings that can be understood by both technical and non-technical stakeholders.`;

  constructor(private readonly stage: StageDefinition) {
    super();
  }

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const { session, workItem } = ctx;
    const phase = 'investigation';

    this.log(session.id, phase, 'info', `InvestigationAgent starting for WI#${workItem.id}`);

    // Equip tools based on stage definition
    this.tools = new ToolRegistry();
    for (const t of buildCodeTools(ctx.repoPath)) {
      if (this.stage.tools.includes(t.name as any)) this.tools.register(t);
    }
    for (const t of buildAdoTools(session.project, workItem.id)) {
      if (this.stage.tools.includes(t.name as any)) this.tools.register(t);
    }
    this.registerMcpTools();

    const taskInstructions = `
## Investigation Task

Work Item #${workItem.id}: ${workItem.title}

**Description:**
${workItem.description || '(no description)'}

**Acceptance Criteria:**
${workItem.acceptanceCriteria || '(none)'}

${this.stage.guidance ? `**Sam's Guidance for this investigation:**\n${this.stage.guidance}\n` : ''}

Use the available tools to investigate. Then produce an InvestigationResult JSON:

{
  "summary": "<1-2 sentence executive summary of findings>",
  "findings": ["<specific finding 1>", "<specific finding 2>", ...],
  "recommendations": ["<actionable recommendation 1>", ...],
  "adoComment": "<full markdown comment to post on the work item — include findings, data, and next steps>"
}

Rules:
- Base findings on actual data from tools, not assumptions
- If a tool returns no data, state that explicitly in findings
- adoComment should be comprehensive and formatted for Azure DevOps markdown
- Respond with ONLY the JSON object
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);

    let responseText: string;
    try {
      responseText = await this.chatWithTools(
        session.id,
        systemPrompt,
        'Please investigate this work item and produce the InvestigationResult JSON.',
        12,
      );
    } catch (err: any) {
      this.log(session.id, phase, 'error', `InvestigationAgent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    const result = this.extractJson<InvestigationResult>(responseText);
    if (!result?.summary) {
      return { success: false, summary: 'InvestigationAgent did not return valid JSON', data: null };
    }

    this.log(session.id, phase, 'decision', `Investigation complete: ${result.summary}`);
    return {
      success: true,
      summary: result.summary,
      data: result,
    };
  }
}
