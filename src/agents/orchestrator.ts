import { EventEmitter } from 'events';
import { AdoWorkItem, getWorkItem, updateWorkItemState, addWorkItemComment } from '../ado/work-items';
import { createDraftPR, getPrCommentThreads, replyToPrCommentThread, resolvePrCommentThread, getPrStatus, PrCommentThread } from '../ado/pull-requests';
import { getConfig } from '../config/manager';
import {
  WorkItemSession, Phase,
  getSession, createSession, updateSessionPhase, updateSessionStatus,
  updateSessionBranch, updateSessionTitle, updateSessionPrUrl, updateSessionWorktreePath,
} from '../memory/session';
import {
  Task, TaskStatus,
  createTask, getTasksForSession, updateTaskStatus,
} from '../memory/tasks';
import { appendAuditEvent } from '../memory/audit';
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
import { createWorktree, createBranch as git_createBranch, stageAndCommit, pushBranch, hasUncommittedChanges, getCurrentBranch } from '../tools/git-tools';
import * as path from 'path';
import * as fs from 'fs';

export interface PhaseCompleteSummary {
  phase: Phase;
  agentPersona: string;
  headline: string;
  details: string[];
  nextPhase?: Phase;
  /** Whether the user can provide feedback to influence the next phase */
  canModify?: boolean;
}

/**
 * Callback invoked after each major phase completes.
 * Return 'continue' to proceed, 'stop' to pause the pipeline,
 * or any other string as modification feedback for the next agent.
 */
export type PhaseCompleteCallback = (summary: PhaseCompleteSummary) => Promise<'continue' | 'stop' | string>;

export interface OrchestratorOptions {
  workItemId: number;
  project?: string;
  codeProject?: string;
  repo?: string;
  orgUrl?: string;
  repoLocalPath?: string;
  dryRun?: boolean;
  sessionId?: number;
  /** Called after each major phase so the user can review and confirm before proceeding */
  onPhaseComplete?: PhaseCompleteCallback;
  /** Called when Sam proposes a pipeline blueprint — return the confirmed/adjusted blueprint */
  onBlueprintProposed?: (blueprint: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>;
}

export type SseEvent =
  | { type: 'phase_change'; phase: Phase }
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
  | { type: 'session_complete' }
  | { type: 'error'; message: string; phase: Phase };

export class Orchestrator extends EventEmitter {
  private config = getConfig();
  private wiReviewAgent = new WorkItemReviewAgent();
  private pmAgent = new PmAgent();
  private devAgent = new DevAgent();
  private reviewAgent = new ReviewAgent();
  private prFixAgent = new PrFixAgent();
  private managerAgent = new ManagerAgent();

  private session!: WorkItemSession;
  private workItem!: AdoWorkItem;
  private tasks: Task[] = [];
  private repoPath = '';      // main repo clone path
  private worktreePath = '';  // isolated worktree for this WI
  private codeProject = '';
  private devOutputs: CodeChangeSet[] = [];
  private pmOutput?: TaskPlan;
  private reviewOutput?: ReviewResult;
  private wiReviewOutput?: WorkItemAnalysis;
  private revisionCount = 0;
  private prId?: number;

  /** Set to true by PipelineManager to signal a graceful stop */
  public stopRequested = false;

  /** Options stored from run() so callbacks are available in all phase methods */
  private _runOpts?: OrchestratorOptions;
  /** User-provided modification feedback from the last phase confirmation dialog */
  private _pendingFeedback?: string;
  /** The confirmed pipeline blueprint — set after Sam proposes and user confirms */
  private blueprint?: PipelineBlueprint;
  /** Investigation output (for investigation pipelines) */
  private investigationOutput?: any;

  emit(event: string, data?: SseEvent): boolean {
    return super.emit(event, data);
  }

  private sse(event: SseEvent): void {
    this.emit('event', event);
  }

  private log(phase: string, eventType: any, message: string, meta?: unknown): void {
    appendAuditEvent(this.session.id, phase, 'orchestrator', eventType, message, meta);
  }

  private transition(phase: Phase): void {
    updateSessionPhase(this.session.id, phase);
    this.session = getSession(this.session.id)!;
    this.log(phase, 'state_change', `Phase → ${phase}`);
    this.sse({ type: 'phase_change', phase });
  }

  private checkStop(): void {
    if (this.stopRequested) {
      updateSessionStatus(this.session.id, 'paused');
      throw new Error('Pipeline stopped by user');
    }
  }

  /**
   * Emits a phase_complete event and optionally awaits the user's confirmation.
   * Returns false if the pipeline should stop (user chose "Stop").
   */
  private async awaitConfirmation(summary: PhaseCompleteSummary): Promise<boolean> {
    this.sse({ type: 'phase_complete', summary });
    const cb = this._runOpts?.onPhaseComplete;
    if (!cb) return true; // auto-continue when no handler registered

    const result = await cb(summary);
    if (result === 'stop') {
      updateSessionStatus(this.session.id, 'paused');
      this.log(summary.phase, 'info', 'Pipeline paused by user at phase confirmation');
      return false;
    }
    // Any non-'continue' string is treated as modification feedback
    if (result !== 'continue') {
      this._pendingFeedback = result;
      this.log(summary.phase, 'info', `User provided feedback: ${result.slice(0, 100)}`);
    }
    return true;
  }

  async run(opts: OrchestratorOptions): Promise<void> {
    this._runOpts = opts;
    const cfg = this.config.getAll();
    const project = opts.project ?? cfg.ado.wiProject;
    const codeProject = opts.codeProject ?? cfg.ado.codeProject;
    const repo = opts.repo ?? cfg.ado.defaultRepo;
    const orgUrl = opts.orgUrl ?? cfg.ado.orgUrl;

    this.codeProject = codeProject;

    const workDir = this.config.getWorkDir();
    fs.mkdirSync(workDir, { recursive: true });
    this.repoPath = opts.repoLocalPath ?? path.join(workDir, repo);

    if (opts.sessionId) {
      const existing = getSession(opts.sessionId);
      if (!existing) throw new Error(`Session ${opts.sessionId} not found`);
      this.session = existing;
      // Restore worktree path from session if resuming
      this.worktreePath = existing.worktreePath ?? '';
    } else {
      this.session = createSession({
        workItemId: opts.workItemId,
        adoOrg: orgUrl,
        project,
        repo,
        branch: '',
        title: '',
        status: 'active',
        phase: 'wi_review',
        prUrl: null,
        worktreePath: null,
      });
    }

    this.workItem = await getWorkItem(project, opts.workItemId);
    updateSessionTitle(this.session.id, this.workItem.title);
    this.tasks = getTasksForSession(this.session.id);

    this.log('wi_review', 'info', `Starting session for WI#${opts.workItemId}: ${this.workItem.title}`);

    // ── Step 1: Sam plans the pipeline ───────────────────────────────────────
    if (!this.blueprint) {
      await this.phaseBlueprintPlanning();
      if (this.stopRequested) return;
    }

    // ── Step 2: Run blueprint stages ─────────────────────────────────────────
    // State machine loop
    while (true) {
      this.checkStop();
      this.session = getSession(this.session.id)!;

      if (this.session.status === 'failed') {
        throw new Error(`Session ${this.session.id} is in failed state`);
      }
      if (this.session.status === 'paused') {
        return; // Paused by agent (e.g. WI not feasible) — stop the loop
      }

      switch (this.session.phase as Phase) {
        case 'wi_review':     await this.phaseWiReview(); break;
        case 'init':          await this.phaseInit(opts.dryRun); break;
        case 'planning':      await this.phasePlanning(opts.dryRun); break;
        case 'development':   await this.phaseDevelopment(); break;
        case 'review':        await this.phaseReview(); break;
        case 'revision':      await this.phaseRevision(); break;
        case 'pr_creation':   await this.phasePrCreation(); break;
        case 'pr_monitoring': return;
        case 'pr_fix':        await this.phasePrFix(); break;
        case 'investigation': await this.phaseInvestigation(); break;
        case 'draft_comment': await this.phaseDraftComment(); break;
        case 'post_comment':  await this.phasePostComment(); break;
        case 'complete':      return;
        default:              return;
      }
    }
  }

  /**
   * Called by the extension when the user chooses "Proceed Anyway" after a WI Review block.
   * Forces the session back to active and skips WI Review.
   */
  async forceResumeFromWiReview(): Promise<void> {
    updateSessionStatus(this.session.id, 'active');
    this.session = getSession(this.session.id)!;
    this.workItem = await getWorkItem(this.session.project, this.session.workItemId);
    this.tasks = getTasksForSession(this.session.id);
    this.worktreePath = this.session.worktreePath ?? '';
    this.wiReviewOutput = { feasible: true, complexity: 'medium', risks: [], enrichedNotes: 'Proceeded despite WI Review blocker (user override).', blockers: [] };
    this.log('wi_review', 'info', 'User overrode WI Review block — proceeding to planning');
    this.transition('init');
    // Continue the state machine
    while (true) {
      this.checkStop();
      this.session = getSession(this.session.id)!;
      if (this.session.status === 'failed' || this.session.status === 'paused') return;
      switch (this.session.phase as Phase) {
        case 'init':          await this.phaseInit(); break;
        case 'planning':      await this.phasePlanning(); break;
        case 'development':   await this.phaseDevelopment(); break;
        case 'review':        await this.phaseReview(); break;
        case 'revision':      await this.phaseRevision(); break;
        case 'pr_creation':   await this.phasePrCreation(); break;
        case 'pr_monitoring': return;
        case 'pr_fix':        await this.phasePrFix(); break;
        case 'complete':      return;
        default:              return;
      }
    }
  }

  /**
   * Called externally by PrMonitor when new comments are found on the PR.
   * Resumes the pipeline from pr_fix phase.
   */
  async resumeForPrFix(threads: PrCommentThread[]): Promise<void> {
    this.session = getSession(this.session.id)!;
    this.workItem = await getWorkItem(this.session.project, this.session.workItemId);
    this.tasks = getTasksForSession(this.session.id);

    // Restore worktree path
    this.worktreePath = this.session.worktreePath ?? '';

    this.transition('pr_fix');
    await this.phasePrFix(threads);
  }

  private buildContext(extraThreads?: PrCommentThread[]): AgentContext {
    const feedback = this._pendingFeedback;
    this._pendingFeedback = undefined; // consume once
    return {
      session: this.session,
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
    };
  }

  // ── Phase: blueprint planning (Sam decides pipeline type) ───────────────────

  private async phaseBlueprintPlanning(): Promise<void> {
    this.log('wi_review', 'info', 'Sam is planning the pipeline...');

    const { blueprint, announcement } = await this.managerAgent.planPipeline(this.workItem);
    this.blueprint = blueprint;
    this.sse({ type: 'blueprint_ready', blueprint, announcement });

    // Let user confirm / adjust via onBlueprintProposed callback
    const cb = this._runOpts?.onBlueprintProposed;
    if (cb) {
      this.blueprint = await cb(blueprint, announcement);
    }

    // Transition to first stage of the blueprint
    const firstStage = this.blueprint.stages[0];
    if (firstStage) {
      this.transition(firstStage.id as Phase);
    }
  }

  // ── Phase: wi_review ────────────────────────────────────────────────────────

  private async phaseWiReview(): Promise<void> {
    const result = await this.wiReviewAgent.run(this.buildContext());

    if (!result.success || !result.data) {
      updateSessionStatus(this.session.id, 'failed');
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
      const blockerMsg = `🚫 WorkItemReviewAgent: Work item #${this.workItem.id} is not feasible.\n\nBlockers:\n${this.wiReviewOutput.blockers.map((b) => `- ${b}`).join('\n')}`;
      try {
        await addWorkItemComment(this.session.project, this.workItem.id, blockerMsg);
      } catch { /* non-critical */ }
      // Pause and emit event — the extension can offer "Proceed Anyway" to override
      updateSessionStatus(this.session.id, 'paused');
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
      nextPhase: 'planning',
      canModify: false,
    });
    if (!shouldContinue) return;

    this.transition('init');
  }

  // ── Phase: init ─────────────────────────────────────────────────────────────

  private async phaseInit(dryRun?: boolean): Promise<void> {
    try {
      await updateWorkItemState(this.session.project, this.workItem.id, 'Active');
      await addWorkItemComment(
        this.session.project,
        this.workItem.id,
        `🤖 myworkbuddy started analysis for WI#${this.workItem.id}\n\n` +
        `**Complexity:** ${this.wiReviewOutput?.complexity ?? 'unknown'}\n` +
        `**Risks:** ${this.wiReviewOutput?.risks?.join(', ') || 'none identified'}`,
      );
    } catch { /* ADO state update is non-critical */ }

    const result = await this.pmAgent.run(this.buildContext());
    if (!result.success || !result.data) {
      updateSessionStatus(this.session.id, 'failed');
      this.sse({ type: 'error', message: result.summary, phase: 'init' });
      throw new Error(result.summary);
    }

    this.pmOutput = result.data as TaskPlan;
    this.sse({ type: 'agent_complete', agent: 'pm (Alex)', summary: result.summary });

    if (dryRun) {
      this.log('init', 'info', 'Dry-run mode: stopping after PM analysis');
      this.transition('complete');
      updateSessionStatus(this.session.id, 'complete');
      this.sse({ type: 'session_complete' });
      return;
    }

    this.transition('planning');
  }

  // ── Phase: planning ──────────────────────────────────────────────────────────

  private async phasePlanning(dryRun?: boolean): Promise<void> {
    const plan = this.pmOutput!;

    // Persist tasks
    this.tasks = [];
    for (const t of plan.tasks) {
      const task = createTask({
        sessionId: this.session.id,
        seq: t.seq,
        title: t.title,
        description: t.description,
        agent: t.agent as 'pm' | 'dev' | 'review',
        status: 'pending',
        resultSummary: null,
      });
      this.tasks.push(task);
    }

    // Create isolated git worktree for this work item
    const worktreesDir = path.join(this.config.getWorkDir(), 'worktrees');
    fs.mkdirSync(worktreesDir, { recursive: true });
    this.worktreePath = path.join(worktreesDir, `wi-${this.workItem.id}`);

    try {
      createWorktree(this.repoPath, this.worktreePath, plan.branchName);
      updateSessionBranch(this.session.id, plan.branchName);
      updateSessionWorktreePath(this.session.id, this.worktreePath);
      this.log('planning', 'info', `Created worktree at: ${this.worktreePath} (branch: ${plan.branchName})`);
      await addWorkItemComment(
        this.session.project,
        this.workItem.id,
        `🌿 Branch \`${plan.branchName}\` created. ${plan.tasks.length} tasks planned.\n\nWorktree: \`${this.worktreePath}\``,
      );
    } catch (err: any) {
      this.log('planning', 'error', `Failed to create worktree: ${err.message}`);
      // Fall back to main repo — but still create + track the branch
      this.worktreePath = this.repoPath;
      try {
        git_createBranch(this.repoPath, plan.branchName);
      } catch (branchErr: any) {
        this.log('planning', 'warn', `Branch creation in main repo also failed: ${branchErr.message}`);
      }
      updateSessionBranch(this.session.id, plan.branchName);
      updateSessionWorktreePath(this.session.id, this.worktreePath);
    }

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

  // ── Phase: development ───────────────────────────────────────────────────────

  private async phaseDevelopment(): Promise<void> {
    const pendingTasks = this.tasks.filter((t) => t.status === 'pending' && t.agent === 'dev');

    for (const task of pendingTasks) {
      this.checkStop();
      updateTaskStatus(task.id, 'running');
      this.sse({ type: 'task_update', taskId: task.id, status: 'running', message: `Starting: ${task.title}` });
      this.tasks = getTasksForSession(this.session.id);

      const result = await this.devAgent.run(this.buildContext(), task.id);

      if (result.success && result.data) {
        updateTaskStatus(task.id, 'done', result.summary);
        this.devOutputs.push(result.data as CodeChangeSet);
        this.sse({ type: 'task_update', taskId: task.id, status: 'done', message: result.summary });

        // Commit after each task so VSCode git UI shows incremental progress
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

      this.tasks = getTasksForSession(this.session.id);
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

  // ── Phase: review ────────────────────────────────────────────────────────────

  private async phaseReview(): Promise<void> {
    const result = await this.reviewAgent.run(this.buildContext());
    if (!result.success || !result.data) {
      updateSessionStatus(this.session.id, 'failed');
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
      this.revisionCount++;
      this.log('review', 'decision', `Review requested changes (attempt ${this.revisionCount}/${this.config.get('agent').maxReviewRetries})`);

      const shouldContinue = await this.awaitConfirmation({
        phase: 'review',
        agentPersona: 'Jordan (Code Reviewer)',
        headline: `Code review score: ${this.reviewOutput.overallScore}/10 — changes requested (revision ${this.revisionCount}/${this.config.get('agent').maxReviewRetries})`,
        details: this.reviewOutput.requestedChanges.length > 0
          ? this.reviewOutput.requestedChanges.map((c) => `• ${c}`)
          : this.reviewOutput.comments.map((c) => `• ${c.file}${c.line ? ':' + c.line : ''} — ${c.comment}`),
        nextPhase: 'revision',
        canModify: false,
      });
      if (!shouldContinue) return;
      this.transition('revision');
    } else {
      this.log('review', 'error', 'Max review retries reached — pausing session for manual intervention');
      updateSessionStatus(this.session.id, 'paused');
      this.sse({ type: 'error', message: 'Max review retries reached. Manual review needed.', phase: 'review' });
    }
  }

  // ── Phase: revision ──────────────────────────────────────────────────────────

  private async phaseRevision(): Promise<void> {
    for (const task of this.tasks.filter((t) => t.agent === 'dev')) {
      updateTaskStatus(task.id, 'pending');
    }
    this.tasks = getTasksForSession(this.session.id);
    this.devOutputs = [];

    this.transition('development');
    await this.phaseDevelopment();
  }

  // ── Phase: pr_creation ───────────────────────────────────────────────────────

  private async phasePrCreation(): Promise<void> {
    const plan = this.pmOutput!;
    const review = this.reviewOutput!;
    const cfg = this.config.getAll();

    // Resolve branch name — fall back to reading it from git if session is stale
    const branchName = this.session.branch?.trim() || getCurrentBranch(this.worktreePath);

    // Safety check: never push directly to a protected branch
    const PROTECTED = ['master', 'main', 'develop', 'dev', 'release'];
    if (PROTECTED.includes(branchName.toLowerCase())) {
      const msg = `Refusing to push to protected branch '${branchName}'. The feature branch was not created correctly — check worktree setup or branch naming.`;
      this.log('pr_creation', 'error', msg);
      updateSessionStatus(this.session.id, 'failed');
      this.sse({ type: 'error', message: msg, phase: 'pr_creation' });
      throw new Error(msg);
    }

    // Push the branch before creating the PR
    try {
      pushBranch(this.worktreePath, branchName);
      this.log('pr_creation', 'info', `Pushed branch: ${branchName}`);
    } catch (err: any) {
      this.log('pr_creation', 'error', `Push failed: ${err.message}`);
      updateSessionStatus(this.session.id, 'failed');
      this.sse({ type: 'error', message: `Push failed: ${err.message}`, phase: 'pr_creation' });
      throw err;
    }

    const reviewSummary = `## Review by Jordan (AI Review Agent)\n\n**Score:** ${review.overallScore}/10\n\n${
      review.comments.map((c) => `- \`${c.file}${c.line ? ':' + c.line : ''}\`: ${c.comment}`).join('\n')
    }`;

    const description = `${plan.prDescription}\n\n---\n\n${reviewSummary}\n\n---\n_Created automatically by [myworkbuddy](https://github.com/myworkbuddy)_`;

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
      updateSessionStatus(this.session.id, 'failed');
      this.sse({ type: 'error', message: err.message, phase: 'pr_creation' });
      throw err;
    }

    this.prId = prResult.prId;
    updateSessionPrUrl(this.session.id, prResult.prUrl);

    getDb().insert(prRecords).values({
      sessionId: this.session.id,
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
        `🚀 Draft PR created by myworkbuddy: ${prResult.prUrl}`,
      );
    } catch { /* non-critical */ }

    this.log('pr_creation', 'info', `PR created: ${prResult.prUrl}`);
    this.sse({ type: 'pr_created', prUrl: prResult.prUrl });

    // Hand off to pr_monitoring — PrMonitor will wake us up when comments arrive
    this.transition('pr_monitoring');

    try {
      await addWorkItemComment(
        this.session.project,
        this.workItem.id,
        `✅ myworkbuddy session complete. PR #${prResult.prId} is ready for human review.\n\n_Monitoring for PR comments to auto-fix..._`,
      );
    } catch { /* non-critical */ }

    this.sse({ type: 'session_complete' });
    // Pipeline yields here — PrMonitor drives pr_fix cycles
  }

  // ── Phase: investigation ─────────────────────────────────────────────────────

  private async phaseInvestigation(): Promise<void> {
    const stage = this.blueprint?.stages.find((s) => s.id === 'investigation')
      ?? { id: 'investigation', label: 'Investigation', agentPersona: 'Alex', tools: ['read_file', 'list_directory', 'search_code', 'search_ado_wiki'] as any };

    const agent = new InvestigationAgent(stage);
    const result = await agent.run(this.buildContext());

    if (!result.success || !result.data) {
      updateSessionStatus(this.session.id, 'failed');
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

    // Check if blueprint has draft_comment next, otherwise go to post_comment
    const stageIds = this.blueprint?.stages.map((s) => s.id) ?? [];
    const nextStage = stageIds.includes('draft_comment') ? 'draft_comment' : 'post_comment';
    this.transition(nextStage as Phase);
  }

  // ── Phase: draft_comment ──────────────────────────────────────────────────────

  private async phaseDraftComment(): Promise<void> {
    // Build comment from investigation output or from scratch (comment-only pipeline)
    let commentText: string;

    if (this.investigationOutput?.adoComment) {
      commentText = this.investigationOutput.adoComment;
    } else {
      // Comment-only pipeline: ask Alex to draft based on the WI itself
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

    // Store for post_comment to use
    this.investigationOutput = { ...(this.investigationOutput ?? {}), adoComment: commentText };
    this.transition('post_comment');
  }

  // ── Phase: post_comment ───────────────────────────────────────────────────────

  private async phasePostComment(): Promise<void> {
    const comment = this.investigationOutput?.adoComment ?? 'Investigation complete — see pipeline logs for details.';
    try {
      await addWorkItemComment(this.session.project, this.workItem.id, comment);
      this.log('post_comment', 'info', 'Comment posted to ADO');
    } catch (err: any) {
      this.log('post_comment', 'error', `Failed to post comment: ${err.message}`);
    }

    this.transition('complete');
    updateSessionStatus(this.session.id, 'complete');
    this.sse({ type: 'session_complete' });
  }

  // ── Phase: pr_fix ────────────────────────────────────────────────────────────

  private async phasePrFix(threads?: PrCommentThread[]): Promise<void> {
    const activeThreads = threads ?? ctx_threads_from_session(this.session);
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

    // Commit and push the fixes
    let commitHash = '';
    if (this.worktreePath && fs.existsSync(this.worktreePath) && hasUncommittedChanges(this.worktreePath)) {
      try {
        commitHash = stageAndCommit(
          this.worktreePath,
          `[WI#${this.workItem.id}] Address PR review comments`,
        );
        pushBranch(this.worktreePath, this.session.branch);
        this.log('pr_fix', 'info', `Pushed PR fix commit: ${commitHash}`);
      } catch (err: any) {
        this.log('pr_fix', 'error', `Push failed: ${err.message}`);
      }
    }

    // Reply to each addressed thread and mark as fixed
    const repoKey = makeRepoKey(this.session.adoOrg, this.session.project, this.session.repo);
    for (const thread of activeThreads) {
      try {
        await replyToPrCommentThread(
          this.codeProject,
          this.session.repo,
          this.prId!,
          thread.threadId,
          `✅ Fixed by myworkbuddy (commit: ${commitHash || 'pending'}).\n\n${fixResult.fixSummary}`,
        );
        await resolvePrCommentThread(this.codeProject, this.session.repo, this.prId!, thread.threadId);

        // Record as processed in DB
        for (const comment of thread.comments) {
          getDb().insert(prComments).values({
            sessionId: this.session.id,
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

    // Return to monitoring for further comments
    this.transition('pr_monitoring');
  }
}

/** Placeholder — threads are injected by PrMonitor, never loaded from session directly */
function ctx_threads_from_session(_session: WorkItemSession): PrCommentThread[] {
  return [];
}
