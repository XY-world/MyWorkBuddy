import { EventEmitter } from 'events';
import { getPrCommentThreads, PrCommentThread, getPrStatus } from '../ado/pull-requests';
import { getSession } from '../memory/session';
import { getDb } from '../db/client';
import { prComments } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { PipelineRunner } from '../agents/pipeline-runner';

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

interface MonitorEntry {
  sessionId: number;
  prId: number;
  project: string;
  repo: string;
  runner: PipelineRunner;
  timer: ReturnType<typeof setInterval>;
}

/**
 * PrMonitor — polls Azure DevOps PR comment threads at a regular interval.
 *
 * When new unprocessed comment threads are found:
 * 1. Wakes the PipelineRunner via resumeForPrFix()
 * 2. The runner executes PrFixAgent to address the comments
 * 3. The monitor continues polling until the PR is merged or abandoned
 */
export class PrMonitor extends EventEmitter {
  private monitors = new Map<number, MonitorEntry>(); // keyed by sessionId
  private manager: EventEmitter;

  constructor(manager: EventEmitter) {
    super();
    this.manager = manager;
  }

  start(
    sessionId: number,
    prId: number,
    project: string,
    repo: string,
    runner: PipelineRunner,
  ): void {
    if (this.monitors.has(sessionId)) return;

    const timer = setInterval(
      () => this.poll(sessionId).catch((err) => {
        console.error(`[PrMonitor] Poll error for session ${sessionId}:`, err.message);
      }),
      POLL_INTERVAL_MS,
    );

    this.monitors.set(sessionId, { sessionId, prId, project, repo, runner, timer });
    console.log(`[PrMonitor] Started monitoring PR #${prId} for session ${sessionId}`);
  }

  stop(workItemId: number): void {
    for (const [sessionId, entry] of this.monitors) {
      const session = getSession(sessionId);
      if (session?.workItemId === workItemId) {
        clearInterval(entry.timer);
        this.monitors.delete(sessionId);
        console.log(`[PrMonitor] Stopped monitoring session ${sessionId}`);
        return;
      }
    }
  }

  stopBySessionId(sessionId: number): void {
    const entry = this.monitors.get(sessionId);
    if (entry) {
      clearInterval(entry.timer);
      this.monitors.delete(sessionId);
      console.log(`[PrMonitor] Stopped monitoring session ${sessionId}`);
    }
  }

  getMonitoredSessionIds(): number[] {
    return Array.from(this.monitors.keys());
  }

  dispose(): void {
    for (const entry of this.monitors.values()) {
      clearInterval(entry.timer);
    }
    this.monitors.clear();
  }

  private async poll(sessionId: number): Promise<void> {
    const entry = this.monitors.get(sessionId);
    if (!entry) return;

    const session = getSession(sessionId);
    if (!session) {
      this.stopBySessionId(sessionId);
      return;
    }

    // Check PR status
    try {
      const prStatus = await getPrStatus(entry.project, entry.repo, entry.prId);
      if (prStatus === 'completed') {
        console.log(`[PrMonitor] PR #${entry.prId} merged — closing session`);
        this.stopBySessionId(sessionId);
        this.manager.emit('session_pr_merged', sessionId, entry.prId);
        return;
      }
      if (prStatus === 'abandoned') {
        console.log(`[PrMonitor] PR #${entry.prId} abandoned — stopping monitor`);
        this.stopBySessionId(sessionId);
        this.manager.emit('session_pr_abandoned', sessionId, entry.prId);
        return;
      }
    } catch { /* Non-critical */ }

    // Fetch active comment threads
    let threads: PrCommentThread[];
    try {
      threads = await getPrCommentThreads(entry.project, entry.repo, entry.prId);
    } catch (err: any) {
      console.error(`[PrMonitor] Failed to fetch PR threads: ${err.message}`);
      return;
    }

    if (threads.length === 0) return;

    // Filter out already processed threads
    const newThreads = threads.filter((t) => !this.isThreadProcessed(sessionId, entry.prId, t.threadId));

    if (newThreads.length === 0) return;

    console.log(`[PrMonitor] Found ${newThreads.length} new comment thread(s) on PR #${entry.prId}`);
    this.manager.emit('pipeline_event', session.workItemId, {
      type: 'pr_comments_found',
      count: newThreads.length,
    });

    // Trigger the fix cycle
    try {
      await entry.runner.resumeForPrFix(newThreads);
    } catch (err: any) {
      console.error(`[PrMonitor] resumeForPrFix failed: ${err.message}`);
    }
  }

  private isThreadProcessed(sessionId: number, prId: number, threadId: number): boolean {
    const db = getDb();
    const existing = db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.sessionId, sessionId),
          eq(prComments.prId, prId),
          eq(prComments.threadId, threadId),
        ),
      )
      .get();
    return !!existing;
  }
}
