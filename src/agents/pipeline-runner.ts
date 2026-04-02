import { EventEmitter } from 'events';
import { AdoWorkItem, getWorkItem, updateWorkItemState, addWorkItemComment } from '../ado/work-items';
import { createDraftPR, getPrCommentThreads, replyToPrCommentThread, resolvePrCommentThread, PrCommentThread } from '../ado/pull-requests';
import { getConfig } from '../config/manager';
import {
  Session, getSession, updateSessionBranch, updateSessionWorktreePath,
  updateSessionTitle, touchSession,
} from '../memory/session';
import {
  PipelineRun, RunPhase,
  getPipelineRun, updateRunPhase, updateRunStatus, updateRunBlueprint,
  updateRunPr, updateRunError, startRun, completeRun, pauseRun,
} from '../memory/pipeline-run';
import {
  Task, TaskStatus,
  createTask, getTasksForRun, updateTaskStatus, resetDevTasksForRun,
} from '../memory/tasks';
import { appendAuditEvent } from '../memory/audit';
import { appendChatMessage, maybeCompressContext, buildChatContext, formatChatContextForPrompt } from '../memory/chat';
import { saveMemory, makeRepoKey } from '../memory/agent-memory';
import { prRecords, prComments } from '../db/schema';
import { getDb } from '../db/client';
import { WorkItemReviewAgent } from './workitem-review-agent';
import { PmAgent } from './pm-agent';
import { DevAgent } from './dev-agent';
import { ReviewAgent } from './review-agent';
import { PrFixAgent } from './pr-fix-agent';
import { InvestigationAgent } from './investigation-agent';
import { ManagerAgent } from './manager-agent';
import { PipelineBlueprint, StageDefinition } from './pipeline-types';
import { TaskPlan, CodeChangeSet, ReviewResult, WorkItemAnalysis, PrFixResult, AgentContext } from './base';
import { createWorktree, createBranch as git_createBranch, stageAndCommit, pushBranch, hasUncommittedChanges, getCurrentBranch, getFullDiff } from '../tools/git-tools';
import * as path from 'path';
import * as fs from 'fs';

export interface PhaseCompleteSummary {
  phase: RunPhase;
  agentPersona: string;
  headline: string;
  details: string[];
  nextPhase?: RunPhase;
  canModify?: boolean;
}

export type PhaseCompleteCallback = (summary: PhaseCompleteSummary) => Promise<'continue' | 'stop' | string>;

export interface PipelineRunnerOptions {
  session: Session;
  run: PipelineRun;
  repoLocalPath?: string;
  onPhaseComplete?: PhaseCompleteCallback;
  onBlueprintProposed?: (blueprint: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>;
}

export type SseEvent =
  | { type: 'phase_change'; phase: RunPhase }
  | { type: 'task_update'; taskId: number; status: TaskStatus; message: string }
  | { type: 'tool_call'; agent: string; tool: string }
  | { type: 'agent_complete'; agent: string; summary: string }
  | { type: 'wi_review_result'; feasible: boolean; complexity: string; risks: string[] }
  | { type: 'wi_review_blocked'; workItemId: number; sessionId: number; blockers: string[] }
  | { type: 'review_result'; approved: boolean; score: number }
  | { type: 'pr_created'; prUrl: string }
  | { type: 'pr_comments_found'; count: number }
  | { type: 'pr_fix_complete'; commentsFixed: number; commitHash: string }
  | { type: 'phase_complete'; summary: PhaseCompleteSummary }
  | { type: 'blueprint_ready'; blueprint: PipelineBlueprint; announcement: string }
  | { type: 'run_complete' }
  | { type: 'error'; message: string; phase: RunPhase };

/**
 * PipelineRunner — executes a single Pipeline Run within a Session.
 * 
 * Key changes from old Orchestrator:
 * - Receives Session and PipelineRun as inputs (not workItemId)
 * - Uses chat history from Session for context
 * - Multiple runs can exist per session (sequentially)
 */
export class PipelineRunner extends EventEmitter {
  private config = getConfig();
  private wiReviewAgent = new WorkItemReviewAgent();
  private pmAgent = new PmAgent();
  private devAgent = new DevAgent();
  private reviewAgent = new ReviewAgent();
  private prFixAgent = new PrFixAgent();
  private managerAgent = new ManagerAgent();

  private session!: Session;
  private run!: PipelineRun;
  private workItem!: AdoWorkItem;
  private tasks: Task[] = [];
  private repoPath = '';
  private worktreePath = '';
  private codeProject = '';
  private devOutputs: CodeChangeSet[] = [];
  private pmOutput?: TaskPlan;
  private reviewOutput?: ReviewResult;
  private wiReviewOutput?: WorkItemAnalysis;
  private revisionCount = 0;
  private prId?: number;

  public stopRequested = false;
  private _runOpts?: PipelineRunnerOptions;
  private _pendingFeedback?: string;
  private blueprint?: PipelineBlueprint;
  private investigationOutput?: any;

  /** Get the work item ID for this runner */
  get workItemId(): number {
    return this.session?.workItemId ?? 0;
  }

  /** Force resume from WI review blocked state */
  async forceResumeFromWiReview(): Promise<void> {
    if (this.run?.phase === 'wi_review') {
      this.transition('planning');
      // Continue with the pipeline
      await this.phasePlanning();
    }
  }

  emit(event: string, data?: SseEvent): boolean {
    return super.emit(event, data);
  }

  private sse(event: SseEvent): void {
    this.emit('event', event);
  }

  private log(phase: string, eventType: any, message: string, meta?: unknown): void {
    appendAuditEvent(this.session.id, phase, 'runner', eventType, message, meta, this.run.id);
  }

  private transition(phase: RunPhase): void {
    updateRunPhase(this.run.id, phase);
    this.run = getPipelineRun(this.run.id)!;
    this.log(phase, 'state_change', `Phase → ${phase}`);
    this.sse({ type: 'phase_change', phase });
  }

  private checkStop(): void {
    if (this.stopRequested) {
      pauseRun(this.run.id);
      throw new Error('Pipeline stopped by user');
    }
  }

  private async awaitConfirmation(summary: PhaseCompleteSummary): Promise<boolean> {
    this.sse({ type: 'phase_complete', summary });
    const cb = this._runOpts?.onPhaseComplete;
    if (!cb) return true;

    const result = await cb(summary);
    if (result === 'stop') {
      pauseRun(this.run.id);
      this.log(summary.phase, 'info', 'Pipeline paused by user at phase confirmation');
      return false;
    }
    if (result !== 'continue') {
      this._pendingFeedback = result;
      this.log(summary.phase, 'info', `User provided feedback: ${result.slice(0, 100)}`);
    }
    return true;
  }

  async execute(opts: PipelineRunnerOptions): Promise<void> {
    this._runOpts = opts;
    this.session = opts.session;
    this.run = opts.run;

    const cfg = this.config.getAll();
    this.codeProject = cfg.ado.codeProject;

    const workDir = this.config.getWorkDir();
    fs.mkdirSync(workDir, { recursive: true });
    this.repoPath = opts.repoLocalPath ?? path.join(workDir, this.session.repo);

    // Use existing worktree from session if available
    this.worktreePath = this.session.worktreePath ?? '';

    // Mark run as started
    startRun(this.run.id);
    touchSession(this.session.id);

    // Load work item
    this.workItem = await getWorkItem(this.session.project, this.session.workItemId);
    updateSessionTitle(this.session.id, this.workItem.title);
    this.tasks = getTasksForRun(this.run.id);

    this.log('init', 'info', `Starting run ${this.run.id} for WI#${this.session.workItemId}: ${this.workItem.title}`);

    // ── Step 1: Sam plans the pipeline (if no blueprint yet) ─────────────────
    if (!this.run.blueprint) {
      await this.phaseBlueprintPlanning();
      if (this.stopRequested) return;
    } else {
      this.blueprint = this.run.blueprint;
    }

    // ── Step 2: Run blueprint stages ─────────────────────────────────────────
    while (true) {
      this.checkStop();
      this.run = getPipelineRun(this.run.id)!;

      if (this.run.status === 'failed') {
        throw new Error(`Run ${this.run.id} is in failed state`);
      }
      if (this.run.status === 'paused') {
        return;
      }

      switch (this.run.phase as RunPhase) {
        case 'wi_review':     await this.phaseWiReview(); break;
        case 'init':          await this.phaseInit(); break;
        case 'planning':      await this.phasePlanning(); break;
        case 'development':   await this.phaseDevelopment(); break;
        case 'review':        await this.phaseReview(); break;
        case 'revision':      await this.phaseRevision(); break;
        case 'pr_creation':   await this.phasePrCreation(); break;
        case 'pr_monitoring': return; // Hand off to PrMonitor
        case 'pr_fix':        await this.phasePrFix(); break;
        case 'investigation': await this.phaseInvestigation(); break;
        case 'draft_comment': await this.phaseDraftComment(); break;
        case 'post_comment':  await this.phasePostComment(); break;
        case 'complete':      return;
        default:              return;
      }
    }
  }

  async resumeForPrFix(threads: PrCommentThread[]): Promise<void> {
    this.session = getSession(this.session.id)!;
    this.run = getPipelineRun(this.run.id)!;
    this.workItem = await getWorkItem(this.session.project, this.session.workItemId);
    this.tasks = getTasksForRun(this.run.id);
    this.worktreePath = this.session.worktreePath ?? '';

    this.transition('pr_fix');
    await this.phasePrFix(threads);
  }

  private buildContext(extraThreads?: PrCommentThread[]): AgentContext {
    const feedback = this._pendingFeedback;
    this._pendingFeedback = undefined;

    // Include chat context from session
    const chatContext = buildChatContext(this.session.id, this.session.contextSummary);

    return {
      session: this.session as any, // Compatibility
      workItem: this.workItem,
      tasks: this.tasks,
      repoPath: this.worktreePath || this.repoPath,
      previousOutputs: {
        pm: this.pmOutput,
        dev: this.devOutputs.length > 0 ? this.devOutputs : undefined,
        review: this.reviewOutput,
        wiReview: this.wiReviewOutput,
      },
      prCommentThreads: extraThreads,
      userFeedback: feedback,
      chatContext, // New: pass chat context to agents
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Blueprint Planning
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseBlueprintPlanning(): Promise<void> {
    this.log('init', 'info', 'Sam is planning the pipeline...');

    const { blueprint, announcement } = await this.managerAgent.planPipeline(this.workItem);
    this.blueprint = blueprint;
    updateRunBlueprint(this.run.id, blueprint);

    // Log Sam's announcement as a chat message
    appendChatMessage({
      sessionId: this.session.id,
      role: 'sam',
      content: announcement,
      pipelineRunId: this.run.id,
    });

    this.sse({ type: 'blueprint_ready', blueprint, announcement });

    const cb = this._runOpts?.onBlueprintProposed;
    if (cb) {
      this.blueprint = await cb(blueprint, announcement);
      updateRunBlueprint(this.run.id, this.blueprint);
    }

    const firstStage = this.blueprint.stages[0];
    if (firstStage) {
      this.transition(firstStage.id as RunPhase);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: WI Review
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseWiReview(): Promise<void> {
    const result = await this.wiReviewAgent.run(this.buildContext());

    if (!result.success || !result.data) {
      updateRunError(this.run.id, result.summary);
      this.sse({ type: 'error', message: result.summary, phase: 'wi_review' });
      throw new Error(result.summary);
    }

    this.wiReviewOutput = result.data as WorkItemAnalysis;
    this.sse({
      type: 'wi_review_result',
      feasible: this.wiReviewOutput.feasible,
      complexity: this.wiReviewOutput.complexity,
      risks: this.wiReviewOutput.risks,
    });
    this.sse({ type: 'agent_complete', agent: `wi_review (${this.wiReviewAgent.persona})`, summary: result.summary });

    if (!this.wiReviewOutput.feasible) {
      const blockerMsg = `🚫 Work item #${this.workItem.id} is not feasible.\n\nBlockers:\n${this.wiReviewOutput.blockers.map((b) => `- ${b}`).join('\n')}`;
      appendChatMessage({ sessionId: this.session.id, role: 'sam', content: blockerMsg, pipelineRunId: this.run.id });
      try {
        await addWorkItemComment(this.session.project, this.workItem.id, blockerMsg);
      } catch { /* non-critical */ }
      pauseRun(this.run.id);
      this.sse({ type: 'wi_review_blocked', workItemId: this.workItem.id, sessionId: this.session.id, blockers: this.wiReviewOutput.blockers });
      return;
    }

    const shouldContinue = await this.awaitConfirmation({
      phase: 'wi_review',
      agentPersona: `Riley (WI Reviewer)`,
      headline: `WI#${this.workItem.id} is feasible — ${this.wiReviewOutput.complexity} complexity`,
      details: [
        ...(this.wiReviewOutput.risks.length > 0
          ? this.wiReviewOutput.risks.map((r) => `⚠ ${r}`)
          : ['No risks identified']),
        ...(this.wiReviewOutput.enrichedNotes
          ? [`Notes: ${this.wiReviewOutput.enrichedNotes.slice(0, 300)}`]
          : []),
      ],
      nextPhase: 'init',
      canModify: false,
    });
    if (!shouldContinue) return;

    this.transition('init');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Init (PM Analysis)
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseInit(): Promise<void> {
    try {
      await updateWorkItemState(this.session.project, this.workItem.id, 'Active');
      await addWorkItemComment(
        this.session.project,
        this.workItem.id,
        `🤖 myworkbuddy started analysis for WI#${this.workItem.id}\n\n` +
        `**Complexity:** ${this.wiReviewOutput?.complexity ?? 'unknown'}\n` +
        `**Risks:** ${this.wiReviewOutput?.risks?.join(', ') || 'none identified'}`,
      );
    } catch { /* non-critical */ }

    const result = await this.pmAgent.run(this.buildContext());
    if (!result.success || !result.data) {
      updateRunError(this.run.id, result.summary);
      this.sse({ type: 'error', message: result.summary, phase: 'init' });
      throw new Error(result.summary);
    }

    this.pmOutput = result.data as TaskPlan;
    this.sse({ type: 'agent_complete', agent: 'pm (Alex)', summary: result.summary });

    this.transition('planning');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Planning
  // ══════════════════════════════════════════════════════════════════════════════

  private async phasePlanning(): Promise<void> {
    const plan = this.pmOutput!;

    // Persist tasks for this run
    this.tasks = [];
    for (const t of plan.tasks) {
      const task = createTask({
        pipelineRunId: this.run.id,
        seq: t.seq,
        title: t.title,
        description: t.description,
        agent: t.agent as any,
        status: 'pending',
        resultSummary: null,
      });
      this.tasks.push(task);
    }

    // Create or reuse worktree
    if (!this.worktreePath || !fs.existsSync(this.worktreePath)) {
      const worktreesDir = path.join(this.config.getWorkDir(), 'worktrees');
      fs.mkdirSync(worktreesDir, { recursive: true });
      this.worktreePath = path.join(worktreesDir, `wi-${this.workItem.id}`);

      try {
        createWorktree(this.repoPath, this.worktreePath, plan.branchName);
        updateSessionBranch(this.session.id, plan.branchName);
        updateSessionWorktreePath(this.session.id, this.worktreePath);
        this.log('planning', 'info', `Created worktree at: ${this.worktreePath} (branch: ${plan.branchName})`);
      } catch (err: any) {
        this.log('planning', 'error', `Failed to create worktree: ${err.message}`);
        this.worktreePath = this.repoPath;
        try {
          git_createBranch(this.repoPath, plan.branchName);
        } catch { /* ignore */ }
        updateSessionBranch(this.session.id, plan.branchName);
        updateSessionWorktreePath(this.session.id, this.worktreePath);
      }
    } else {
      // Reuse existing worktree
      this.log('planning', 'info', `Reusing existing worktree: ${this.worktreePath}`);
    }

    await addWorkItemComment(
      this.session.project,
      this.workItem.id,
      `🌿 Branch \`${plan.branchName}\` — ${plan.tasks.length} tasks planned.`,
    );

    this.sse({ type: 'task_update', taskId: 0, status: 'pending', message: `${plan.tasks.length} tasks queued` });

    const shouldContinue = await this.awaitConfirmation({
      phase: 'planning',
      agentPersona: 'Alex (Planner)',
      headline: `${plan.tasks.length} tasks planned on branch '${plan.branchName}'`,
      details: plan.tasks.map((t) => `${t.seq}. ${t.title}`),
      nextPhase: 'development',
      canModify: true,
    });
    if (!shouldContinue) return;

    this.transition('development');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Development
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseDevelopment(): Promise<void> {
    const pendingTasks = this.tasks.filter((t) => t.status === 'pending' && t.agent === 'dev');

    for (const task of pendingTasks) {
      this.checkStop();
      updateTaskStatus(task.id, 'running');
      this.sse({ type: 'task_update', taskId: task.id, status: 'running', message: `Starting: ${task.title}` });
      this.tasks = getTasksForRun(this.run.id);

      const result = await this.devAgent.run(this.buildContext(), task.id);

      if (result.success && result.data) {
        updateTaskStatus(task.id, 'done', result.summary);
        this.devOutputs.push(result.data as CodeChangeSet);
        this.sse({ type: 'task_update', taskId: task.id, status: 'done', message: result.summary });

        if (this.worktreePath && fs.existsSync(this.worktreePath) && hasUncommittedChanges(this.worktreePath)) {
          try {
            stageAndCommit(this.worktreePath, `[WI#${this.workItem.id}] ${task.title}`);
            this.log('development', 'info', `Committed task: ${task.title}`);
          } catch (err: any) {
            this.log('development', 'error', `Commit failed: ${err.message}`);
          }
        }
      } else {
        updateTaskStatus(task.id, 'failed', result.summary);
        this.sse({ type: 'task_update', taskId: task.id, status: 'failed', message: result.summary });
        this.log('development', 'error', `Task ${task.id} failed: ${result.summary}`);
      }

      this.tasks = getTasksForRun(this.run.id);
    }

    this.sse({ type: 'agent_complete', agent: 'dev (Morgan)', summary: `${this.devOutputs.length} tasks completed` });

    const allFiles = this.devOutputs.flatMap((o) => o.filesModified);
    const shouldContinue = await this.awaitConfirmation({
      phase: 'development',
      agentPersona: 'Morgan (Developer)',
      headline: `${this.devOutputs.length} dev tasks completed, ${allFiles.length} file(s) changed`,
      details: allFiles.length > 0 ? allFiles.map((f) => `• ${f}`) : ['No file changes recorded'],
      nextPhase: 'review',
      canModify: false,
    });
    if (!shouldContinue) return;

    this.transition('review');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Review
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseReview(): Promise<void> {
    const result = await this.reviewAgent.run(this.buildContext());
    if (!result.success || !result.data) {
      updateRunError(this.run.id, result.summary);
      this.sse({ type: 'error', message: result.summary, phase: 'review' });
      throw new Error(result.summary);
    }

    this.reviewOutput = result.data as ReviewResult;
    this.sse({ type: 'review_result', approved: this.reviewOutput.approved, score: this.reviewOutput.overallScore });
    this.sse({ type: 'agent_complete', agent: 'review (Jordan)', summary: result.summary });

    if (result.newMemories) {
      const repoKey = makeRepoKey(this.session.adoOrg, this.session.project, this.session.repo);
      for (const m of result.newMemories) {
        saveMemory('review', repoKey, m.type, m.key, m.value, m.confidence, this.session.id);
      }
    }

    if (this.reviewOutput.approved) {
      const shouldContinue = await this.awaitConfirmation({
        phase: 'review',
        agentPersona: 'Jordan (Code Reviewer)',
        headline: `Code review passed (score: ${this.reviewOutput.overallScore}/10) — ready for PR`,
        details: this.reviewOutput.comments.length > 0
          ? this.reviewOutput.comments.map((c) => `• ${c.file}${c.line ? ':' + c.line : ''} — ${c.comment}`)
          : ['No issues found'],
        nextPhase: 'pr_creation',
        canModify: false,
      });
      if (!shouldContinue) return;
      this.transition('pr_creation');
    } else if (this.revisionCount < this.config.get('agent').maxReviewRetries) {
      // Check if diff changed from last revision to avoid infinite loop
      const currentDiff = getFullDiff(this.worktreePath);
      if (this._lastDiff && this._lastDiff === currentDiff) {
        this.log('review', 'warn', 'No changes detected since last revision — pausing for manual intervention');
        appendChatMessage({
          sessionId: this.session.id,
          role: 'sam',
          content: `⚠️ Review requested changes, but Morgan made no effective changes. Manual intervention needed.`,
          pipelineRunId: this.run.id,
        });
        pauseRun(this.run.id);
        return;
      }
      this._lastDiff = currentDiff;

      this.revisionCount++;
      this.log('review', 'decision', `Review requested changes (attempt ${this.revisionCount}/${this.config.get('agent').maxReviewRetries})`);

      const shouldContinue = await this.awaitConfirmation({
        phase: 'review',
        agentPersona: 'Jordan (Code Reviewer)',
        headline: `Code review score: ${this.reviewOutput.overallScore}/10 — changes requested (revision ${this.revisionCount})`,
        details: this.reviewOutput.requestedChanges.length > 0
          ? this.reviewOutput.requestedChanges.map((c) => `• ${c}`)
          : this.reviewOutput.comments.map((c) => `• ${c.file}${c.line ? ':' + c.line : ''} — ${c.comment}`),
        nextPhase: 'revision',
        canModify: false,
      });
      if (!shouldContinue) return;
      this.transition('revision');
    } else {
      this.log('review', 'error', 'Max review retries reached — pausing for manual intervention');
      pauseRun(this.run.id);
      this.sse({ type: 'error', message: 'Max review retries reached. Manual review needed.', phase: 'review' });
    }
  }

  private _lastDiff?: string;

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Revision
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseRevision(): Promise<void> {
    resetDevTasksForRun(this.run.id);
    this.tasks = getTasksForRun(this.run.id);
    this.devOutputs = [];

    this.transition('development');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: PR Creation
  // ══════════════════════════════════════════════════════════════════════════════

  private async phasePrCreation(): Promise<void> {
    const plan = this.pmOutput!;
    const review = this.reviewOutput!;
    const cfg = this.config.getAll();

    const branchName = this.session.branch?.trim() || getCurrentBranch(this.worktreePath);

    // Safety check
    const PROTECTED = ['master', 'main', 'develop', 'dev', 'release'];
    if (PROTECTED.includes(branchName.toLowerCase())) {
      const msg = `Refusing to push to protected branch '${branchName}'.`;
      this.log('pr_creation', 'error', msg);
      updateRunError(this.run.id, msg);
      this.sse({ type: 'error', message: msg, phase: 'pr_creation' });
      throw new Error(msg);
    }

    try {
      pushBranch(this.worktreePath, branchName);
      this.log('pr_creation', 'info', `Pushed branch: ${branchName}`);
    } catch (err: any) {
      this.log('pr_creation', 'error', `Push failed: ${err.message}`);
      updateRunError(this.run.id, `Push failed: ${err.message}`);
      this.sse({ type: 'error', message: `Push failed: ${err.message}`, phase: 'pr_creation' });
      throw err;
    }

    const reviewSummary = `## Review by Jordan (AI Review Agent)\n\n**Score:** ${review.overallScore}/10\n\n${
      review.comments.map((c) => `- \`${c.file}${c.line ? ':' + c.line : ''}\`: ${c.comment}`).join('\n')
    }`;

    const description = `${plan.prDescription}\n\n---\n\n${reviewSummary}\n\n---\n_Created by [myworkbuddy](https://github.com/myworkbuddy)_`;

    let prResult;
    try {
      prResult = await createDraftPR({
        project: this.codeProject,
        repo: this.session.repo,
        sourceBranch: branchName,
        targetBranch: 'main',
        title: plan.prTitle,
        description,
        workItemId: this.workItem.id,
        isDraft: true,
      });
    } catch (err: any) {
      this.log('pr_creation', 'error', `Failed to create PR: ${err.message}`);
      updateRunError(this.run.id, err.message);
      this.sse({ type: 'error', message: err.message, phase: 'pr_creation' });
      throw err;
    }

    this.prId = prResult.prId;
    updateRunPr(this.run.id, prResult.prId, prResult.prUrl);

    getDb().insert(prRecords).values({
      sessionId: this.session.id,
      pipelineRunId: this.run.id,
      prId: prResult.prId,
      prUrl: prResult.prUrl,
      prTitle: plan.prTitle,
      targetBranch: 'main',
      status: 'draft',
      createdAt: Date.now(),
    }).run();

    try {
      await updateWorkItemState(this.session.project, this.workItem.id, 'In Review');
      await addWorkItemComment(
        this.session.project,
        this.workItem.id,
        `🚀 Draft PR created: ${prResult.prUrl}`,
      );
    } catch { /* non-critical */ }

    appendChatMessage({
      sessionId: this.session.id,
      role: 'sam',
      content: `✅ Draft PR created: ${prResult.prUrl}\n\nWaiting for human review. I'll automatically address any PR comments.`,
      pipelineRunId: this.run.id,
    });

    this.log('pr_creation', 'info', `PR created: ${prResult.prUrl}`);
    this.sse({ type: 'pr_created', prUrl: prResult.prUrl });

    this.transition('pr_monitoring');

    // Compress chat context if needed
    await maybeCompressContext(this.session.id, this.session.contextSummary ?? undefined);

    this.sse({ type: 'run_complete' });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: PR Fix
  // ══════════════════════════════════════════════════════════════════════════════

  private async phasePrFix(threads?: PrCommentThread[]): Promise<void> {
    const activeThreads = threads ?? [];
    if (activeThreads.length === 0) {
      this.transition('pr_monitoring');
      return;
    }

    this.sse({ type: 'pr_comments_found', count: activeThreads.length });
    this.log('pr_fix', 'info', `Fixing ${activeThreads.length} PR comment thread(s)`);

    const result = await this.prFixAgent.run(this.buildContext(activeThreads));

    if (!result.success || !result.data) {
      this.log('pr_fix', 'error', `PrFixAgent failed: ${result.summary}`);
      this.sse({ type: 'error', message: result.summary, phase: 'pr_fix' });
      this.transition('pr_monitoring');
      return;
    }

    const fixResult = result.data as PrFixResult;

    let commitHash = '';
    if (this.worktreePath && fs.existsSync(this.worktreePath) && hasUncommittedChanges(this.worktreePath)) {
      try {
        commitHash = stageAndCommit(this.worktreePath, `[WI#${this.workItem.id}] Address PR review comments`);
        pushBranch(this.worktreePath, this.session.branch);
        this.log('pr_fix', 'info', `Pushed PR fix commit: ${commitHash}`);
      } catch (err: any) {
        this.log('pr_fix', 'error', `Push failed: ${err.message}`);
      }
    }

    for (const thread of activeThreads) {
      try {
        await replyToPrCommentThread(
          this.codeProject,
          this.session.repo,
          this.prId!,
          thread.threadId,
          `✅ Fixed (commit: ${commitHash || 'pending'}).\n\n${fixResult.fixSummary}`,
        );
        await resolvePrCommentThread(this.codeProject, this.session.repo, this.prId!, thread.threadId);

        for (const comment of thread.comments) {
          getDb().insert(prComments).values({
            sessionId: this.session.id,
            pipelineRunId: this.run.id,
            prId: this.prId!,
            threadId: thread.threadId,
            commentId: comment.id,
            content: comment.content,
            author: comment.author,
            status: 'fixed',
            fixCommit: commitHash,
            createdAt: Date.now(),
            processedAt: Date.now(),
          }).run();
        }
      } catch (err: any) {
        this.log('pr_fix', 'error', `Failed to reply/resolve thread ${thread.threadId}: ${err.message}`);
      }
    }

    this.sse({ type: 'pr_fix_complete', commentsFixed: fixResult.commentsFixed, commitHash });
    this.sse({ type: 'agent_complete', agent: 'pr_fix (Morgan)', summary: result.summary });

    this.transition('pr_monitoring');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Investigation
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseInvestigation(): Promise<void> {
    const stage = this.blueprint?.stages.find((s) => s.id === 'investigation')
      ?? { id: 'investigation', label: 'Investigation', agentPersona: 'Alex', tools: ['read_file', 'list_directory', 'search_code'] as any };

    const agent = new InvestigationAgent(stage);
    const result = await agent.run(this.buildContext());

    if (!result.success || !result.data) {
      updateRunError(this.run.id, result.summary);
      this.sse({ type: 'error', message: result.summary, phase: 'investigation' });
      throw new Error(result.summary);
    }

    this.investigationOutput = result.data;
    this.sse({ type: 'agent_complete', agent: 'investigation (Alex)', summary: result.summary });

    const shouldContinue = await this.awaitConfirmation({
      phase: 'investigation',
      agentPersona: 'Alex (Investigator)',
      headline: result.summary,
      details: (this.investigationOutput.findings ?? []).slice(0, 6),
      nextPhase: 'draft_comment',
      canModify: true,
    });
    if (!shouldContinue) return;

    const stageIds = this.blueprint?.stages.map((s) => s.id) ?? [];
    const nextStage = stageIds.includes('draft_comment') ? 'draft_comment' : 'post_comment';
    this.transition(nextStage as RunPhase);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Draft Comment
  // ══════════════════════════════════════════════════════════════════════════════

  private async phaseDraftComment(): Promise<void> {
    let commentText: string;

    if (this.investigationOutput?.adoComment) {
      commentText = this.investigationOutput.adoComment;
    } else {
      const stage = this.blueprint?.stages.find((s) => s.id === 'draft_comment')
        ?? { id: 'draft_comment', label: 'Draft Comment', agentPersona: 'Alex', tools: ['read_ado_workitem'] as any };
      const agent = new InvestigationAgent(stage);
      const result = await agent.run(this.buildContext());
      commentText = (result.data as any)?.adoComment ?? result.summary;
    }

    this.sse({ type: 'agent_complete', agent: 'draft_comment (Alex)', summary: 'Comment drafted' });

    const shouldContinue = await this.awaitConfirmation({
      phase: 'draft_comment',
      agentPersona: 'Alex',
      headline: 'Comment drafted — ready to post to ADO',
      details: commentText.split('\n').slice(0, 5),
      nextPhase: 'post_comment',
      canModify: true,
    });
    if (!shouldContinue) return;

    this.investigationOutput = { ...(this.investigationOutput ?? {}), adoComment: commentText };
    this.transition('post_comment');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase: Post Comment
  // ══════════════════════════════════════════════════════════════════════════════

  private async phasePostComment(): Promise<void> {
    const comment = this.investigationOutput?.adoComment ?? 'Investigation complete — see pipeline logs for details.';
    try {
      await addWorkItemComment(this.session.project, this.workItem.id, comment);
      this.log('post_comment', 'info', 'Comment posted to ADO');
    } catch (err: any) {
      this.log('post_comment', 'error', `Failed to post comment: ${err.message}`);
    }

    completeRun(this.run.id);
    await maybeCompressContext(this.session.id, this.session.contextSummary ?? undefined);
    this.sse({ type: 'run_complete' });
  }
}
