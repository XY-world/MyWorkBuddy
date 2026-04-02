import { createCopilotSession } from '../tools/copilot-client';
import { PhaseCompleteSummary } from './orchestrator';
import {
  PipelineBlueprint, PipelineType, StageDefinition,
  CODING_PIPELINE, INVESTIGATION_PIPELINE, COMMENT_PIPELINE,
} from './pipeline-types';
import { AdoWorkItem } from '../ado/work-items';

export { PipelineBlueprint };

export interface ChatMessage {
  role: 'user' | 'sam';
  text: string;
  timestamp: number;
}

/** VSCode UI actions Sam can trigger on behalf of the user */
export type VsAction = 'openInVscode' | 'reviewCode' | 'openPr';

export interface ManagerDecision {
  /** Message from Sam to show in chat */
  reply: string;
  /** Resolved pipeline action — undefined means "just answer, keep waiting" */
  action?: 'continue' | 'stop' | 'feedback';
  /** Feedback text for the next agent (when action === 'feedback') */
  feedback?: string;
  /** VSCode UI action Sam wants to trigger */
  vsAction?: VsAction;
}

const SOUL = `You are Sam, a senior Engineering Manager AI running inside Visual Studio Code.

You coordinate a software development team working on Azure DevOps work items:
- Riley (WI Reviewer): assesses feasibility and risks before coding starts
- Alex (Planner): breaks the work into concrete tasks and creates the git branch
- Morgan (Developer): writes the actual code, one task at a time
- Jordan (Code Reviewer): reviews code quality and requests changes if needed

Your role:
- Be the single point of contact between the developer and the AI team
- Keep communication concise and professional — no fluff
- Proactively announce what the team just did and what happens next
- When a phase completes, present a brief summary and ask if the developer wants to proceed
- If the developer gives instructions, extract them clearly and pass to the right agent
- If the developer asks a question, answer it from the context you have

You CAN trigger the following Visual Studio Code actions directly:
- "openInVscode": Open the worktree folder in a new VSCode window for the developer to browse/run the code
- "reviewCode": Open git diff tabs showing every file changed vs the base branch
- "openPr": Open the pull request URL in the browser

When the developer asks you to open the code, open VSCode, review the diff, or open the PR — trigger the appropriate action immediately. Do NOT say you cannot do it.

You do NOT produce code yourself. You manage the team and the VSCode workspace.`;

const PHASE_NAMES: Record<string, string> = {
  wi_review: 'WI Review',
  planning:  'Planning',
  development: 'Development',
  review: 'Code Review',
  pr_creation: 'PR Creation',
};

const NEXT_PHASE: Record<string, string> = {
  wi_review:   'Planning',
  planning:    'Development',
  development: 'Code Review',
  review:      'PR Creation',
};

/**
 * ManagerAgent (Sam) — the conversational layer between the developer and the AI pipeline team.
 * Announces phase completions and interprets free-text developer responses into pipeline actions.
 * Also responsible for building the pipeline blueprint based on the work item.
 */
export class ManagerAgent {

  /**
   * Analyzes a work item and proposes a pipeline blueprint.
   * Returns the blueprint AND a natural-language explanation for the user.
   */
  async planPipeline(workItem: AdoWorkItem): Promise<{ blueprint: PipelineBlueprint; announcement: string }> {
    const prompt = `You are Sam, an Engineering Manager AI.

Read this Azure DevOps work item and decide what kind of pipeline to run:

**WI#${workItem.id}: ${workItem.title}**
Type: ${workItem.type}
Description: ${workItem.description || '(none)'}
Acceptance Criteria: ${workItem.acceptanceCriteria || '(none)'}
Tags: ${workItem.tags || '(none)'}

Available pipeline types:
- "coding": Write code, create a PR. Use when the WI asks to implement a feature, fix a bug, or refactor code.
- "investigation": Research data, APIs, or systems and post findings as an ADO comment. Use when the WI asks to investigate, analyze, research, or explore.
- "comment": Draft and post a targeted comment/response on the WI. Use when the WI is a question, feedback, or just needs a written response — no code changes.

You can also customize the stages. For "coding", you can add or remove stages.
For "investigation", specify what data sources the investigator should use (e.g. KQL, wiki, code search).

Respond with JSON only:
{
  "type": "coding" | "investigation" | "comment",
  "rationale": "<1-2 sentence explanation of why you chose this pipeline>",
  "stageGuidance": {
    "<stageId>": "<specific guidance for this stage based on the WI, e.g. 'focus on the DNS wildcard expansion logic in src/dns/'>"
  },
  "announcement": "<2-3 sentence message to the developer explaining your plan in plain language>"
}`;

    const raw = await this._call(prompt, []);
    const json = this._extractJson(raw);

    if (!json) {
      // Fallback
      return {
        blueprint: { type: 'coding', rationale: 'Defaulting to coding pipeline.', stages: CODING_PIPELINE },
        announcement: `I'll run the standard coding pipeline for WI#${workItem.id}. Let me know if you'd like a different approach.`,
      };
    }

    const type: PipelineType = json.type ?? 'coding';
    const baseStages: StageDefinition[] =
      type === 'investigation' ? INVESTIGATION_PIPELINE :
      type === 'comment'       ? COMMENT_PIPELINE :
                                 CODING_PIPELINE;

    // Inject per-stage guidance from Sam's analysis
    const stages = baseStages.map((s) => ({
      ...s,
      guidance: json.stageGuidance?.[s.id] ?? s.guidance,
    }));

    return {
      blueprint: { type, rationale: json.rationale ?? '', stages },
      announcement: json.announcement ?? `I'll run a ${type} pipeline for this work item.`,
    };
  }

  /**
   * Interprets a user reply to a pipeline proposal ("ok", "actually investigation", "add a kql stage").
   * Returns an adjusted blueprint or null if the user confirmed as-is.
   */
  async refinePlan(
    userMessage: string,
    currentBlueprint: PipelineBlueprint,
    workItem: AdoWorkItem,
  ): Promise<{ blueprint: PipelineBlueprint; reply: string } | null> {
    const lower = userMessage.toLowerCase().trim();
    // Quick accept
    if (/^(ok|yes|go|sure|proceed|sounds good|lgtm|correct|start|👍)/.test(lower)) {
      return null;
    }

    const prompt = `You are Sam. The developer responded to your pipeline proposal.

Work item: WI#${workItem.id} — ${workItem.title}
Current plan: ${currentBlueprint.type} pipeline (${currentBlueprint.stages.map((s) => s.label).join(' → ')})
Developer says: "${userMessage}"

If they want to change the pipeline type or add specific instructions, adjust and return:
{
  "type": "coding" | "investigation" | "comment",
  "rationale": "...",
  "stageGuidance": { "<stageId>": "<guidance>" },
  "reply": "<your 1-2 sentence acknowledgement to the developer>"
}
If they are just confirming or asking a question (not changing the plan), return:
{
  "type": null,
  "reply": "<your answer>"
}`;

    const raw = await this._call(prompt, []);
    const json = this._extractJson(raw);
    if (!json || !json.type) {
      return { blueprint: currentBlueprint, reply: json?.reply ?? raw };
    }

    const type: PipelineType = json.type;
    const baseStages =
      type === 'investigation' ? INVESTIGATION_PIPELINE :
      type === 'comment'       ? COMMENT_PIPELINE :
                                 CODING_PIPELINE;
    const stages = baseStages.map((s) => ({
      ...s,
      guidance: json.stageGuidance?.[s.id] ?? s.guidance,
    }));

    return {
      blueprint: { type, rationale: json.rationale ?? '', stages },
      reply: json.reply ?? `Switching to ${type} pipeline.`,
    };
  }

  /**
   * Generates Sam's natural-language announcement when a phase completes.
   * Called right before the panel awaits user confirmation.
   */
  async announcePhaseComplete(
    summary: PhaseCompleteSummary,
    history: ChatMessage[],
  ): Promise<string> {
    const detailBlock = summary.details && summary.details.length > 0
      ? `\nDetails:\n${summary.details.slice(0, 8).map((d) => `  - ${d}`).join('\n')}`
      : '';

    const next = NEXT_PHASE[summary.phase];
    const canFeedback = summary.canModify;

    const userPrompt =
      `Phase just completed: ${summary.agentPersona} — ${summary.headline}${detailBlock}

Write a brief message (2-4 sentences) to the developer:
1. Summarise what the team just did (1-2 sentences)
2. State what will happen next (${next ?? 'completion'})
3. Ask if they want to proceed${canFeedback ? ', or if they have instructions for the team' : ''}

Be direct. No pleasantries.`;

    return this._call(userPrompt, history.slice(-6));
  }

  /**
   * Interprets a free-text developer message and returns Sam's reply + optional pipeline action.
   * Called every time the user sends a message while a phase decision is pending.
   */
  async processMessage(
    userMessage: string,
    pendingPhase: string | undefined,
    history: ChatMessage[],
    pipelineContext: string,
  ): Promise<ManagerDecision> {
    const pendingBlock = pendingPhase
      ? `The team is waiting for a decision on: ${PHASE_NAMES[pendingPhase] ?? pendingPhase}`
      : 'No decision pending right now.';

    const historyBlock = history.slice(-8).map((m) =>
      `${m.role === 'user' ? 'Developer' : 'Sam'}: ${m.text}`
    ).join('\n');

    const userPrompt =
      `${pipelineContext}

${pendingBlock}

Conversation so far:
${historyBlock || '(none)'}

Developer just said: "${userMessage}"

Respond in JSON only — no other text:
{
  "action": "continue" | "stop" | "feedback" | "answer",
  "reply": "<your 1-3 sentence reply to show the developer>",
  "feedback": "<instructions for the next agent if action=feedback, else null>",
  "vsAction": "openInVscode" | "reviewCode" | "openPr" | null
}

Rules:
- "continue": developer approves, wants to proceed (e.g. "ok", "go", "looks good", "yes")
- "stop": developer wants to pause or cancel (e.g. "stop", "pause", "wait", "cancel")
- "feedback": developer has specific instructions to pass to the team (e.g. "add unit tests", "also handle edge case X") — extract the instruction verbatim into "feedback"
- "answer": developer is asking a question or chatting — just reply, do NOT proceed
- Only set "continue"/"stop"/"feedback" when a decision is actually pending AND the message clearly resolves it
- When in doubt, use "answer"
- vsAction: set to the appropriate action when the developer asks to open VSCode/code/worktree ("openInVscode"), see the diff/changes ("reviewCode"), or open the PR ("openPr"). Otherwise null.`;

    const raw = await this._call(userPrompt, []);
    return this._parseDecision(raw, userMessage);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async _call(userPrompt: string, history: ChatMessage[]): Promise<string> {
    // Build system prompt with history context
    const historyText = history.length > 0
      ? '\n\nRecent conversation:\n' + history.map((m) =>
          `${m.role === 'user' ? 'Developer' : 'Sam'}: ${m.text}`
        ).join('\n')
      : '';

    const session = await createCopilotSession(SOUL + historyText);
    try {
      const response = await session.sendAndWait({ prompt: userPrompt });
      return response.text;
    } finally {
      await session.close();
    }
  }

  private _extractJson(raw: string): any {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  private _parseDecision(raw: string, fallbackUserMsg: string): ManagerDecision {
    const parsed = this._extractJson(raw);
    const validVsActions: VsAction[] = ['openInVscode', 'reviewCode', 'openPr'];
    if (parsed) {
      return {
        reply: parsed.reply || raw,
        action: ['continue', 'stop', 'feedback', 'answer'].includes(parsed.action)
          ? parsed.action === 'answer' ? undefined : parsed.action
          : undefined,
        feedback: parsed.feedback || undefined,
        vsAction: validVsActions.includes(parsed.vsAction) ? parsed.vsAction : undefined,
      };
    }
    // Fallback: heuristic parse
    const lower = fallbackUserMsg.toLowerCase().trim();
    // VSCode action shortcuts
    if (/open.*(vscode|code|worktree|folder)/i.test(lower)) {
      return { reply: "Opening the worktree in VSCode.", vsAction: 'openInVscode' };
    }
    if (/review.*(code|diff|change)|open.*(diff|change)/i.test(lower)) {
      return { reply: "Opening the code diff.", vsAction: 'reviewCode' };
    }
    if (/open.*(pr|pull request)/i.test(lower)) {
      return { reply: "Opening the PR.", vsAction: 'openPr' };
    }
    if (/^(ok|yes|go|proceed|continue|sure|sounds good|looks good|lgtm|👍)/.test(lower)) {
      return { reply: "Got it — proceeding.", action: 'continue' };
    }
    if (/^(stop|pause|cancel|wait|hold|no)/.test(lower)) {
      return { reply: "Pausing the pipeline.", action: 'stop' };
    }
    return { reply: raw, action: undefined };
  }
}
