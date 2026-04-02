import { EventEmitter } from 'events';
import { PipelineRunner, PipelineRunnerOptions, SseEvent, PhaseCompleteCallback } from '../agents/pipeline-runner';
import { PipelineBlueprint } from '../agents/pipeline-types';
import {
  Session, getSession, getActiveSessionByWorkItem, getOrCreateSession, closeSession, touchSession,
} from '../memory/session';
import {
  PipelineRun, createPipelineRun, getPipelineRun, getActiveRunForSession,
  getQueuedRunsForSession, getLatestRunForSession, updateRunStatus, TriggerSource,
} from '../memory/pipeline-run';
import { PrMonitor } from './pr-monitor';
import { getConfig } from '../config/manager';

export interface SessionStatus {
  sessionId: number;
  workItemId: number;
  title: string;
  sessionStatus: string;
  branch?: string | null;
  worktreePath?: string | null;
  currentRun?: {
    runId: number;
    type: string;
    phase: string;
    status: string;
    prUrl?: string | null;
  };
  queuedRuns: number;
  lastActivityAt: number;
}

interface ActiveRunner {
  runner: PipelineRunner;
  session: Session;
  run: PipelineRun;
  startedAt: number;
  lastEvent?: SseEvent;
  promise: Promise<void>;
}

interface QueuedRun {
  session: Session;
  run: PipelineRun;
  opts: Omit<PipelineRunnerOptions, 'session' | 'run'>;
  onPhaseComplete?: PhaseCompleteCallback;
  onBlueprintProposed?: (bp: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>;
  queuedAt: number;
}

/**
 * PipelineManager — manages pipeline execution with the new Session/Run model.
 *
 * Key concepts:
 * - Session: 1:1 with Work Item, long-lived
 * - PipelineRun: A single execution within a session
 * - Same-session runs are serialized (queued)
 * - Cross-session runs can be parallel (up to maxConcurrency)
 */
export class PipelineManager extends EventEmitter {
  private activeRunners = new Map<number, ActiveRunner>(); // keyed by sessionId
  private sessionQueues = new Map<number, QueuedRun[]>();  // queued runs per session
  private prMonitor: PrMonitor;

  constructor() {
    super();
    this.prMonitor = new PrMonitor(this);
  }

  private getMaxConcurrency(): number {
    return getConfig().get('agent').maxConcurrency || 2;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Start a new pipeline run
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Start a new pipeline run for a work item.
   * Creates or reuses a session, creates a new run, and executes it.
   */
  async startRun(
    workItemId: number,
    opts: {
      adoOrg: string;
      project: string;
      repo: string;
      title: string;
      repoLocalPath?: string;
      runType?: string;
      triggeredBy?: TriggerSource;
    },
    onPhaseComplete?: PhaseCompleteCallback,
    onBlueprintProposed?: (bp: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>,
  ): Promise<{ sessionId: number; runId: number }> {
    // Get or create session
    const { session, isNew } = getOrCreateSession({
      workItemId,
      adoOrg: opts.adoOrg,
      project: opts.project,
      repo: opts.repo,
      title: opts.title,
    });

    if (session.status === 'closed') {
      throw new Error(`Session for WI#${workItemId} is closed (reason: ${session.closedReason}). Cannot start new runs.`);
    }

    // Create pipeline run
    const run = createPipelineRun({
      sessionId: session.id,
      type: opts.runType || 'user_initiated',
      triggeredBy: opts.triggeredBy || 'user',
    });

    console.log(`[PipelineManager] Created run ${run.id} for session ${session.id} (WI#${workItemId})`);

    // Check if this session already has an active run
    if (this.activeRunners.has(session.id)) {
      // Queue this run
      this.queueRun(session, run, {
        repoLocalPath: opts.repoLocalPath,
      }, onPhaseComplete, onBlueprintProposed);
      return { sessionId: session.id, runId: run.id };
    }

    // Check global concurrency
    if (this.activeRunners.size >= this.getMaxConcurrency()) {
      // Queue this run
      this.queueRun(session, run, {
        repoLocalPath: opts.repoLocalPath,
      }, onPhaseComplete, onBlueprintProposed);
      return { sessionId: session.id, runId: run.id };
    }

    // Start immediately
    this.executeRun(session, run, {
      repoLocalPath: opts.repoLocalPath,
    }, onPhaseComplete, onBlueprintProposed);

    return { sessionId: session.id, runId: run.id };
  }

  private queueRun(
    session: Session,
    run: PipelineRun,
    opts: Omit<PipelineRunnerOptions, 'session' | 'run'>,
    onPhaseComplete?: PhaseCompleteCallback,
    onBlueprintProposed?: (bp: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>,
  ): void {
    if (!this.sessionQueues.has(session.id)) {
      this.sessionQueues.set(session.id, []);
    }
    this.sessionQueues.get(session.id)!.push({
      session,
      run,
      opts,
      onPhaseComplete,
      onBlueprintProposed,
      queuedAt: Date.now(),
    });

    this.emit('run_queued', session.workItemId, run.id);
    console.log(`[PipelineManager] Run ${run.id} queued for session ${session.id} (${this.sessionQueues.get(session.id)!.length} in queue)`);
  }

  private executeRun(
    session: Session,
    run: PipelineRun,
    opts: Omit<PipelineRunnerOptions, 'session' | 'run'>,
    onPhaseComplete?: PhaseCompleteCallback,
    onBlueprintProposed?: (bp: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>,
  ): void {
    const runner = new PipelineRunner();
    const startedAt = Date.now();

    runner.on('event', (event: SseEvent) => {
      const entry = this.activeRunners.get(session.id);
      if (entry) entry.lastEvent = event;

      this.emit('pipeline_event', session.workItemId, event);

      // Start PR monitoring when PR is created
      if (event.type === 'pr_created') {
        const latestRun = getPipelineRun(run.id);
        if (latestRun?.prId) {
          this.prMonitor.start(session.id, latestRun.prId, session.project, session.repo, runner);
        }
      }

      // On run complete, process queue
      if (event.type === 'run_complete') {
        this.onRunComplete(session.id);
      }
    });

    const promise = runner
      .execute({
        session,
        run,
        ...opts,
        onPhaseComplete,
        onBlueprintProposed,
      })
      .catch((err) => {
        this.emit('pipeline_error', session.workItemId, err.message);
      })
      .finally(() => {
        this.onRunComplete(session.id);
      });

    this.activeRunners.set(session.id, {
      runner,
      session,
      run,
      startedAt,
      promise,
    });

    this.emit('pipeline_started', session.workItemId, run.id);
    console.log(`[PipelineManager] Run ${run.id} started for session ${session.id} (${this.activeRunners.size}/${this.getMaxConcurrency()} active)`);
  }

  private onRunComplete(sessionId: number): void {
    const activeEntry = this.activeRunners.get(sessionId);
    
    // Check if run ended in pr_monitoring (don't remove from active)
    if (activeEntry) {
      const run = getPipelineRun(activeEntry.run.id);
      if (run?.phase === 'pr_monitoring') {
        // Keep the runner for PR fix cycles
        console.log(`[PipelineManager] Run ${run.id} entered pr_monitoring — keeping runner active`);
        return;
      }
    }

    this.activeRunners.delete(sessionId);

    // Process session queue first
    const sessionQueue = this.sessionQueues.get(sessionId);
    if (sessionQueue && sessionQueue.length > 0) {
      const next = sessionQueue.shift()!;
      if (sessionQueue.length === 0) {
        this.sessionQueues.delete(sessionId);
      }
      console.log(`[PipelineManager] Dequeuing run ${next.run.id} from session ${sessionId} queue`);
      this.executeRun(next.session, next.run, next.opts, next.onPhaseComplete, next.onBlueprintProposed);
      return;
    }

    // Process other sessions' queues if under capacity
    this.processGlobalQueue();
  }

  private processGlobalQueue(): void {
    if (this.activeRunners.size >= this.getMaxConcurrency()) return;

    // Find a session with queued runs that isn't currently active
    for (const [sessionId, queue] of this.sessionQueues) {
      if (this.activeRunners.has(sessionId)) continue;
      if (queue.length === 0) continue;

      const next = queue.shift()!;
      if (queue.length === 0) {
        this.sessionQueues.delete(sessionId);
      }

      console.log(`[PipelineManager] Dequeuing run ${next.run.id} from session ${sessionId} (global)`);
      this.executeRun(next.session, next.run, next.opts, next.onPhaseComplete, next.onBlueprintProposed);

      if (this.activeRunners.size >= this.getMaxConcurrency()) break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Stop / Control
  // ══════════════════════════════════════════════════════════════════════════════

  stopRun(sessionId: number): void {
    // Check session queue first
    const queue = this.sessionQueues.get(sessionId);
    if (queue) {
      for (const q of queue) {
        updateRunStatus(q.run.id, 'paused');
      }
      this.sessionQueues.delete(sessionId);
    }

    // Stop active runner
    const active = this.activeRunners.get(sessionId);
    if (active) {
      active.runner.stopRequested = true;
      this.prMonitor.stopBySessionId(sessionId);
      this.activeRunners.delete(sessionId);
      this.emit('pipeline_stopped', active.session.workItemId);
      console.log(`[PipelineManager] Stopped session ${sessionId}`);
    }

    this.processGlobalQueue();
  }

  stopRunByWorkItem(workItemId: number): void {
    const session = getActiveSessionByWorkItem(workItemId);
    if (session) {
      this.stopRun(session.id);
    }
  }

  closeSession(sessionId: number, reason: 'resolved' | 'reassigned' | 'manual'): void {
    this.stopRun(sessionId);
    closeSession(sessionId, reason);
    this.emit('session_closed', sessionId, reason);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Status
  // ══════════════════════════════════════════════════════════════════════════════

  getSessionStatus(sessionId: number): SessionStatus | null {
    const session = getSession(sessionId);
    if (!session) return null;

    const activeEntry = this.activeRunners.get(sessionId);
    const activeRun = activeEntry ? getPipelineRun(activeEntry.run.id) : getLatestRunForSession(sessionId);
    const queuedCount = this.sessionQueues.get(sessionId)?.length ?? 0;

    return {
      sessionId: session.id,
      workItemId: session.workItemId,
      title: session.title,
      sessionStatus: session.status,
      branch: session.branch,
      worktreePath: session.worktreePath,
      currentRun: activeRun ? {
        runId: activeRun.id,
        type: activeRun.type,
        phase: activeRun.phase,
        status: activeRun.status,
        prUrl: activeRun.prUrl,
      } : undefined,
      queuedRuns: queuedCount,
      lastActivityAt: session.lastActivityAt,
    };
  }

  getAllSessions(): SessionStatus[] {
    const statuses: SessionStatus[] = [];

    // Active sessions
    for (const [sessionId] of this.activeRunners) {
      const status = this.getSessionStatus(sessionId);
      if (status) statuses.push(status);
    }

    // PR monitoring sessions
    const monitoredSessionIds = this.prMonitor.getMonitoredSessionIds();
    for (const sessionId of monitoredSessionIds) {
      if (statuses.some((s) => s.sessionId === sessionId)) continue;
      const status = this.getSessionStatus(sessionId);
      if (status) statuses.push(status);
    }

    // Queued sessions
    for (const [sessionId] of this.sessionQueues) {
      if (statuses.some((s) => s.sessionId === sessionId)) continue;
      const status = this.getSessionStatus(sessionId);
      if (status) statuses.push(status);
    }

    return statuses;
  }

  isSessionActive(sessionId: number): boolean {
    return this.activeRunners.has(sessionId);
  }

  getRunner(sessionId: number): PipelineRunner | undefined {
    return this.activeRunners.get(sessionId)?.runner;
  }

  /** Get runner by work item ID (for extension compatibility) */
  getRunnerByWorkItem(workItemId: number): PipelineRunner | undefined {
    for (const [, entry] of this.activeRunners) {
      if (entry.runner.workItemId === workItemId) {
        return entry.runner;
      }
    }
    return undefined;
  }

  getStats(): { activeSessions: number; queuedRuns: number; maxConcurrency: number } {
    let queuedRuns = 0;
    for (const q of this.sessionQueues.values()) {
      queuedRuns += q.length;
    }
    return {
      activeSessions: this.activeRunners.size,
      queuedRuns,
      maxConcurrency: this.getMaxConcurrency(),
    };
  }

  get monitor(): PrMonitor {
    return this.prMonitor;
  }

  dispose(): void {
    this.prMonitor.dispose();
    for (const [sessionId] of this.activeRunners) {
      this.stopRun(sessionId);
    }
    this.sessionQueues.clear();
  }
}

// Singleton
let _instance: PipelineManager | null = null;

export function getPipelineManager(): PipelineManager {
  if (!_instance) {
    _instance = new PipelineManager();
  }
  return _instance;
}
