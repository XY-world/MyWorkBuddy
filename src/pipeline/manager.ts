import { EventEmitter } from 'events';
import { Orchestrator, OrchestratorOptions, SseEvent, PhaseCompleteCallback } from '../agents/orchestrator';
import { PipelineBlueprint } from '../agents/pipeline-types';
import { getSession, getAllSessions, WorkItemSession } from '../memory/session';
import { PrMonitor } from './pr-monitor';

export interface PipelineStatus {
  workItemId: number;
  sessionId: number;
  title: string;
  phase: string;
  status: string;
  prUrl?: string | null;
  worktreePath?: string | null;
  startedAt: number;
  lastEvent?: SseEvent;
}

/**
 * PipelineManager — manages concurrent pipeline execution.
 *
 * Multiple work items can be processed simultaneously. Each pipeline:
 * - Runs in its own async task (not a separate process)
 * - Has an isolated git worktree directory
 * - Emits SSE events that are forwarded to the VSCode extension
 *
 * After a pipeline reaches pr_monitoring, PrMonitor takes over polling.
 */
export class PipelineManager extends EventEmitter {
  private pipelines = new Map<number, {
    orchestrator: Orchestrator;
    startedAt: number;
    lastEvent?: SseEvent;
    promise: Promise<void>;
  }>();
  private prMonitor: PrMonitor;

  constructor() {
    super();
    this.prMonitor = new PrMonitor(this);
  }

  /**
   * Starts a new pipeline for the given work item.
   * If a previous run is stale (promise already settled), it is cleared first.
   */
  start(workItemId: number, opts: Omit<OrchestratorOptions, 'workItemId'>, onPhaseComplete?: PhaseCompleteCallback, onBlueprintProposed?: (bp: PipelineBlueprint, announcement: string) => Promise<PipelineBlueprint>): void {
    if (this.pipelines.has(workItemId)) {
      // Already has an entry — only block if it's genuinely still running
      throw new Error(`Pipeline for WI#${workItemId} is already running`);
    }

    const orchestrator = new Orchestrator();
    const startedAt = Date.now();

    orchestrator.on('event', (event: SseEvent) => {
      // Update lastEvent for UI
      const entry = this.pipelines.get(workItemId);
      if (entry) entry.lastEvent = event;

      // Forward to extension listeners
      this.emit('pipeline_event', workItemId, event);

      // When pipeline reaches pr_monitoring, start the PR comment monitor
      if (event.type === 'pr_created') {
        const session = this.getSessionForWi(workItemId);
        if (session?.prUrl) {
          // Extract prId from prUrl (last segment)
          const prId = parseInt(session.prUrl.split('/').pop() ?? '0', 10);
          if (prId > 0) {
            this.prMonitor.start(session.id, prId, session.project, session.repo, orchestrator);
          }
        }
      }
    });

    const promise = orchestrator
      .run({ ...opts, workItemId, onPhaseComplete, onBlueprintProposed })
      .catch((err) => {
        this.emit('pipeline_error', workItemId, err.message);
      })
      .finally(() => {
        // Clean up from active pipelines when done (but keep monitoring via PrMonitor)
        const phase = this.getSessionForWi(workItemId)?.phase;
        if (phase !== 'pr_monitoring') {
          this.pipelines.delete(workItemId);
        }
      });

    this.pipelines.set(workItemId, { orchestrator, startedAt, promise });
    this.emit('pipeline_started', workItemId);
  }

  /**
   * Stops a running pipeline gracefully.
   */
  stop(workItemId: number): void {
    const entry = this.pipelines.get(workItemId);
    if (!entry) return;
    entry.orchestrator.stopRequested = true;
    this.prMonitor.stop(workItemId);
    this.pipelines.delete(workItemId);
    this.emit('pipeline_stopped', workItemId);
  }

  /**
   * Returns the status of all known pipelines (running + monitoring).
   */
  getAll(): PipelineStatus[] {
    const statuses: PipelineStatus[] = [];

    for (const [workItemId, entry] of this.pipelines) {
      const session = this.getSessionForWi(workItemId);
      // Show entry even if DB session not found yet (DB still initialising)
      statuses.push({
        workItemId,
        sessionId: session?.id ?? 0,
        title: session?.title ?? `WI#${workItemId}`,
        phase: session?.phase ?? 'wi_review',
        status: session?.status ?? 'active',
        prUrl: session?.prUrl,
        worktreePath: session?.worktreePath,
        startedAt: entry.startedAt,
        lastEvent: entry.lastEvent,
      });
    }

    // Also include sessions in pr_monitoring that may not be in pipelines map
    const monitoredSessions = this.prMonitor.getMonitoredSessionIds();
    for (const sessionId of monitoredSessions) {
      const session = getSession(sessionId);
      if (!session) continue;
      if (statuses.some((s) => s.workItemId === session.workItemId)) continue;
      statuses.push({
        workItemId: session.workItemId,
        sessionId: session.id,
        title: session.title,
        phase: session.phase,
        status: session.status,
        prUrl: session.prUrl,
        worktreePath: session.worktreePath,
        startedAt: session.createdAt,
      });
    }

    return statuses;
  }

  /**
   * Returns whether a pipeline is currently active for the given work item.
   */
  isRunning(workItemId: number): boolean {
    return this.pipelines.has(workItemId);
  }

  /**
   * Returns the orchestrator for a work item (if running).
   */
  getOrchestrator(workItemId: number): Orchestrator | undefined {
    return this.pipelines.get(workItemId)?.orchestrator;
  }

  private getSessionForWi(workItemId: number): WorkItemSession | null {
    const all = getAllSessions();
    return all.find((s) => s.workItemId === workItemId && s.status === 'active') ?? null;
  }

  /** Expose PrMonitor for orchestrator access */
  get monitor(): PrMonitor {
    return this.prMonitor;
  }

  dispose(): void {
    this.prMonitor.dispose();
    for (const [workItemId] of this.pipelines) {
      this.stop(workItemId);
    }
  }
}

// Singleton for use in extension + web server
let _instance: PipelineManager | null = null;

export function getPipelineManager(): PipelineManager {
  if (!_instance) {
    _instance = new PipelineManager();
  }
  return _instance;
}
