import * as vscode from 'vscode';
import { SseEvent, PhaseCompleteSummary } from '../agents/orchestrator';

/**
 * PipelineLogger — one Output Channel per pipeline.
 * Translates SseEvents into human-readable log lines shown in the OUTPUT panel.
 */
export class PipelineLogger {
  private channels = new Map<number, vscode.OutputChannel>();

  /** Called when a pipeline starts — creates a fresh output channel */
  create(workItemId: number, title: string): vscode.OutputChannel {
    // Dispose any previous channel for the same WI
    this.dispose(workItemId);

    const channel = vscode.window.createOutputChannel(
      `MyWorkBuddy — WI#${workItemId}: ${title}`,
      'log',
    );
    this.channels.set(workItemId, channel);
    channel.show(true); // show without stealing focus
    channel.appendLine(`[${ts()}] Pipeline started for WI#${workItemId}: ${title}`);
    channel.appendLine('─'.repeat(60));
    return channel;
  }

  /** Translates an SseEvent into a log line */
  log(workItemId: number, event: SseEvent): void {
    const channel = this.channels.get(workItemId);
    if (!channel) return;

    const line = eventToLine(event);
    if (line) channel.appendLine(`[${ts()}] ${line}`);
  }

  logError(workItemId: number, message: string): void {
    const channel = this.channels.get(workItemId);
    if (channel) {
      channel.appendLine(`[${ts()}] ✖ ERROR: ${message}`);
    }
  }

  /** Displays a rich phase-completion summary block in the output channel */
  logPhaseSummary(workItemId: number, summary: PhaseCompleteSummary): void {
    const channel = this.channels.get(workItemId);
    if (!channel) return;
    channel.appendLine('');
    channel.appendLine(`[${ts()}] ┌─────────────────────────────────────────────`);
    channel.appendLine(`[${ts()}] │ ✔ ${summary.agentPersona}`);
    channel.appendLine(`[${ts()}] │   ${summary.headline}`);
    if (summary.details.length > 0) {
      channel.appendLine(`[${ts()}] │`);
      for (const detail of summary.details) {
        channel.appendLine(`[${ts()}] │   ${detail}`);
      }
    }
    if (summary.nextPhase) {
      channel.appendLine(`[${ts()}] │`);
      channel.appendLine(`[${ts()}] │   Next: ${summary.nextPhase.replace(/_/g, ' ')} — awaiting your confirmation...`);
    }
    channel.appendLine(`[${ts()}] └─────────────────────────────────────────────`);
    channel.appendLine('');
  }

  /** Logs user-provided feedback in the output channel */
  logUserFeedback(workItemId: number, feedback: string): void {
    const channel = this.channels.get(workItemId);
    if (!channel) return;
    channel.appendLine(`[${ts()}] 💬 User feedback: ${feedback}`);
  }

  /** Opens the Output Channel for a specific WI */
  show(workItemId: number): void {
    this.channels.get(workItemId)?.show();
  }

  dispose(workItemId: number): void {
    this.channels.get(workItemId)?.dispose();
    this.channels.delete(workItemId);
  }

  disposeAll(): void {
    for (const [id] of this.channels) this.dispose(id);
  }
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function eventToLine(event: SseEvent): string {
  switch (event.type) {
    case 'phase_change':
      return `\n━━ Phase: ${event.phase.toUpperCase().replace(/_/g, ' ')} ━━`;
    case 'wi_review_result':
      return `WI Review: ${event.feasible ? '✔ Feasible' : '✖ Not Feasible'} | Complexity: ${event.complexity} | Risks: ${event.risks.length}`;
    case 'agent_complete':
      return `✔ ${event.agent}: ${event.summary}`;
    case 'task_update':
      if (event.status === 'running')  return `  ↻ Task: ${event.message}`;
      if (event.status === 'done')     return `  ✔ Done: ${event.message}`;
      if (event.status === 'failed')   return `  ✖ Failed: ${event.message}`;
      return `  Task [${event.status}]: ${event.message}`;
    case 'review_result':
      return `Code Review: ${event.approved ? '✔ Approved' : '✖ Changes Requested'} (score: ${event.score}/10)`;
    case 'pr_created':
      return `✔ PR Created: ${event.prUrl}`;
    case 'pr_comments_found':
      return `PR: ${event.count} new comment thread(s) found — triggering auto-fix`;
    case 'pr_fix_complete':
      return `✔ PR Fix: ${event.commentsFixed} comment(s) fixed | commit: ${event.commitHash}`;
    case 'phase_complete':
      return ''; // handled by logPhaseSummary — suppress inline duplicate
    case 'run_complete':
      return '\n✔ Pipeline complete!';
    case 'error':
      return `✖ Error in [${event.phase}]: ${event.message}`;
    default:
      return '';
  }
}
