import { AdoWorkItem } from '../ado/work-items';
import { WorkItemSession, Phase } from '../memory/session';
import { Task } from '../memory/tasks';
import { appendAuditEvent, AuditEventType } from '../memory/audit';
import { appendMessage } from '../memory/agent-messages';
import { loadMemories, formatMemoriesForPrompt, makeRepoKey, AgentMemoryEntry } from '../memory/agent-memory';
import { createCopilotSession, getCopilotMcpTools, ToolDefinition, ToolRegistry } from '../tools/copilot-client';
import { PrCommentThread } from '../ado/pull-requests';
import { getSettings } from '../config/settings-manager';

export interface TaskPlan {
  branchName: string;
  prTitle: string;
  prDescription: string;
  tasks: Array<{
    seq: number;
    title: string;
    description: string;
    agent: 'pm' | 'dev' | 'review';
  }>;
}

export interface CodeChangeSet {
  filesModified: string[];
  summary: string;
}

export interface ReviewResult {
  approved: boolean;
  overallScore: number;
  comments: Array<{ file: string; line?: number; comment: string }>;
  requestedChanges: string[];
}

/** Output from WorkItemReviewAgent: feasibility + enriched context for planning */
export interface WorkItemAnalysis {
  feasible: boolean;
  complexity: 'low' | 'medium' | 'high';
  risks: string[];
  enrichedNotes: string;   // additional context the planning agent should know
  blockers: string[];      // issues that must be resolved before proceeding
}

/** Output from PrFixAgent: which comments were addressed and what commits were made */
export interface PrFixResult {
  commentsFixed: number;
  commitHash: string;
  fixSummary: string;
}

export interface AgentContext {
  session: WorkItemSession;
  workItem: AdoWorkItem;
  tasks: Task[];
  repoPath: string;
  previousOutputs: {
    pm?: TaskPlan;
    dev?: CodeChangeSet[];
    review?: ReviewResult;
    wiReview?: WorkItemAnalysis;
  };
  /** Present during pr_fix phase */
  prCommentThreads?: PrCommentThread[];
  /** User-provided modification instructions from phase confirmation dialog */
  userFeedback?: string;
}

export interface AgentOutput {
  success: boolean;
  summary: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: TaskPlan | CodeChangeSet | ReviewResult | WorkItemAnalysis | PrFixResult | any | null;
  nextPhase?: Phase;
  newMemories?: Array<{ type: 'code_pattern' | 'team_preference' | 'lesson_learned' | 'standard'; key: string; value: string; confidence: number }>;
}

export abstract class BaseAgent {
  abstract readonly agentKey: 'pm' | 'dev' | 'review' | 'wi_review' | 'pr_fix';
  abstract readonly persona: string;
  abstract readonly soul: string;
  abstract readonly userPerspective: string;

  protected tools: ToolRegistry = new ToolRegistry();

  abstract run(ctx: AgentContext, taskId?: number): Promise<AgentOutput>;

  /** Returns the effective soul — setting override takes precedence over hardcoded value */
  protected effectiveSoul(): string {
    const s = getSettings().getAgentSettings(this.agentKey);
    return s?.soulOverride?.trim() || this.soul;
  }

  /** Returns the effective user perspective — setting override takes precedence */
  protected effectiveUserPerspective(): string {
    const s = getSettings().getAgentSettings(this.agentKey);
    return s?.userPerspectiveOverride?.trim() || this.userPerspective;
  }

  protected buildSystemPrompt(ctx: AgentContext, taskInstructions: string): string {
    const repoKey = makeRepoKey(ctx.session.adoOrg, ctx.session.project, ctx.session.repo);
    const memories = loadMemories(this.agentKey === 'wi_review' ? 'pm' : this.agentKey === 'pr_fix' ? 'dev' : this.agentKey, repoKey);
    const memoryBlock = formatMemoriesForPrompt(memories);

    const parts = [
      this.effectiveSoul(),
      `\n## Your Stakeholder Perspective\n${this.effectiveUserPerspective()}`,
    ];
    if (memoryBlock) parts.push(`\n## Your Memory of This Repository\n${memoryBlock}`);

    // Inject attached skills
    const agentCfg = getSettings().getAgentSettings(this.agentKey);
    if (agentCfg?.attachedSkillIds?.length) {
      const skills = getSettings().getSkills().filter((s) => agentCfg.attachedSkillIds.includes(s.id));
      if (skills.length > 0) {
        parts.push(`\n## Team Standards & Practices\n${skills.map((s) => `- ${s.promptText}`).join('\n')}`);
      }
    }

    if (ctx.userFeedback) {
      parts.push(`\n## Developer Feedback (MUST incorporate)\n${ctx.userFeedback}`);
    }
    parts.push(`\n## Your Current Task\n${taskInstructions}`);

    return parts.join('\n');
  }

  /** Register Copilot MCP tools into this agent's tool registry if enabled in settings */
  protected registerMcpTools(): void {
    const mcps = getSettings().getEnabledMcps();
    const hasBuiltinCopilot = mcps.some((m) => m.type === 'builtin-copilot' && m.enabled);
    if (hasBuiltinCopilot) {
      for (const tool of getCopilotMcpTools()) {
        this.tools.register(tool);
      }
    }
  }

  protected log(
    sessionId: number,
    phase: string,
    eventType: AuditEventType,
    message: string,
    metadata?: unknown,
  ): void {
    appendAuditEvent(sessionId, phase, `${this.agentKey} (${this.persona})`, eventType, message, metadata);
  }

  protected async chat(
    sessionId: number,
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    appendMessage(sessionId, this.agentKey, 'system', systemPrompt);
    appendMessage(sessionId, this.agentKey, 'user', userMessage);

    const session = await createCopilotSession(systemPrompt);
    let responseText = '';
    try {
      const response = await session.sendAndWait({ prompt: userMessage });
      responseText = response.text;
    } finally {
      await session.close();
    }

    appendMessage(sessionId, this.agentKey, 'assistant', responseText);
    return responseText;
  }

  protected async chatWithTools(
    sessionId: number,
    systemPrompt: string,
    userMessage: string,
    maxIterations = 10,
    onToolCall?: (name: string, args: unknown, result: unknown) => void,
  ): Promise<string> {
    appendMessage(sessionId, this.agentKey, 'system', systemPrompt);
    appendMessage(sessionId, this.agentKey, 'user', userMessage);

    const copilotSession = await createCopilotSession(systemPrompt);
    let lastResponse = '';

    try {
      for (let i = 0; i < maxIterations; i++) {
        const response = await copilotSession.sendAndWait({
          prompt: i === 0 ? userMessage : 'continue',
          tools: this.tools.toToolSchemas() as unknown as ToolDefinition[],
        });

        lastResponse = response.text;
        appendMessage(sessionId, this.agentKey, 'assistant', lastResponse);

        if (lastResponse.includes('"done": true') || lastResponse.includes('"done":true')) {
          break;
        }

        const toolCallMatch = lastResponse.match(/"tool_call"\s*:\s*\{[^}]+\}/);
        if (!toolCallMatch) break;
      }
    } finally {
      await copilotSession.close();
    }

    return lastResponse;
  }

  protected extractJson<T>(text: string): T | null {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1] : text;
    try {
      return JSON.parse(jsonStr.trim());
    } catch {
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch { /* ignored */ }
      }
    }
    return null;
  }
}
