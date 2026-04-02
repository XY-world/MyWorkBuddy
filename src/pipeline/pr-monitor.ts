import { EventEmitter } from 'events';
import { getPrCommentThreads, PrCommentThread } from '../ado/pull-requests';
import { getSession } from '../memory/session';
import { getDb } from '../db/client';
import { prComments } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { Orchestrator } from '../agents/orchestrator';

const POLL_INTERVAL_MS = 2 * 60 * 1000; // poll every 2 minutes

interface MonitorEntry {
  sessionId: number;
  prId: number;
  project: string;
  repo: string;
  orchestrator: Orchestrator;
  timer: ReturnType<typeof setInterval>;
}

/**
 * PrMonitor — polls Azure DevOps PR comment threads at a regular interval.
 *
 * When new unprocessed comment threads are found:
 * 1. Wakes the Orchestrator via resumeForPrFix()
 * 2. The Orchestrator runs PrFixAgent to address the comments
 * 3. The monitor continues polling until the PR is merged or abandoned
 */
export class PrMonitor extends EventEmitter {
  private monitors = new Map<number, MonitorEntry>(); // keyed by sessionId
  private manager: EventEmitter;

  constructor(manager: EventEmitter) {
    super();
    this.manager = manager;
  }

  /**
   * Starts monitoring a PR for new comments.
   */
  start(
    sessionId: number,
    prId: number,
    project: string,
    repo: string,
    orchestrator: Orchestrator,
  ): void {
    if (this.monitors.has(sessionId)) return; // already monitoring

    const timer = setInterval(
      () => this.poll(sessionId).catch((err) => {
        console.error(`[PrMonitor] Poll error for session ${sessionId}:`, err.message);
      }),
      POLL_INTERVAL_MS,
    );

    this.monitors.set(sessionId, { sessionId, prId, project, repo, orchestrator, timer });
    console.log(`[PrMonitor] Started monitoring PR #${prId} for session ${sessionId}`);
  }

  /**
   * Stops monitoring for a session (e.g. PR merged, pipeline stopped).
   */
  stop(workItemId: number): void {
    // Find session by work item id
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
    }
  }

  getMonitoredSessionIds(): number[] {
    return Array.from(this.monitors.keys());
  }

  dispose(): void {
    for (const [, entry] of this.monitors) {
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

    // Stop monitoring if PR is merged or abandoned
    try {
      const { getPrStatus } = await import('../ado/pull-requests');
      const prStatus = await getPrStatus(entry.project, entry.repo, entry.prId);
      if (prStatus === 'completed' || prStatus === 'abandoned') {
        console.log(`[PrMonitor] PR #${entry.prId} is ${prStatus}, stopping monitor`);
        this.stopBySessionId(sessionId);
        return;
      }
    } catch { /* Non-critical — keep monitoring */ }

    // Fetch active comment threads
    let threads: PrCommentThread[];
    try {
      threads = await getPrCommentThreads(entry.project, entry.repo, entry.prId);
    } catch (err: any) {
      console.error(`[PrMonitor] Failed to fetch PR threads: ${err.message}`);
      return;
    }

    if (threads.length === 0) return;

    // Filter out threads we've already processed
    const newThreads = threads.filter((t) => !this.isThreadProcessed(sessionId, entry.prId, t.threadId));

    if (newThreads.length === 0) return;

    console.log(`[PrMonitor] Found ${newThreads.length} new comment thread(s) on PR #${entry.prId}`);
    this.manager.emit('pipeline_event', session.workItemId, {
      type: 'pr_comments_found',
      count: newThreads.length,
    });

    // Trigger the fix cycle
    try {
      await entry.orchestrator.resumeForPrFix(newThreads);
    } catch (err: any) {
      console.error(`[PrMonitor] resumeForPrFix failed for session ${sessionId}: ${err.message}`);
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
