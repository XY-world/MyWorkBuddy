import * as vscode from 'vscode';
import { PipelineManager, SessionStatus } from '../../pipeline/manager';

// ── Tree node types ──────────────────────────────────────────────────────────

export type PipelineNode = SessionRootNode | PipelineDetailNode | MessageNode;

const PHASE_ICONS: Record<string, string> = {
  pending:       'circle-outline',
  queued:        'clock',
  wi_review:     'search',
  init:          'person',
  planning:      'list-ordered',
  development:   'code',
  review:        'eye',
  revision:      'refresh',
  pr_creation:   'git-pull-request',
  pr_monitoring: 'bell',
  pr_fix:        'tools',
  investigation: 'search',
  draft_comment: 'comment',
  post_comment:  'comment-discussion',
  complete:      'check',
};

const PHASE_LABELS: Record<string, string> = {
  pending:       'Pending',
  queued:        'Queued',
  wi_review:     'WI Review',
  init:          'Analysis',
  planning:      'Planning',
  development:   'Development',
  review:        'Code Review',
  revision:      'Revision',
  pr_creation:   'Creating PR',
  pr_monitoring: 'Monitoring PR',
  pr_fix:        'Fixing PR Comments',
  investigation: 'Investigation',
  draft_comment: 'Drafting Comment',
  post_comment:  'Posting Comment',
  complete:      'Complete',
};

/**
 * SessionRootNode represents a Session (Work Item) in the tree.
 * Shows the current run's phase/status.
 */
export class SessionRootNode extends vscode.TreeItem {
  readonly nodeType = 'session' as const;
  constructor(public readonly session: SessionStatus) {
    super(
      `WI#${session.workItemId}: ${session.title || 'Loading...'}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = 'session';
    this.command = {
      command: 'myworkbuddy.openPipelineDetail',
      title: 'Open Pipeline Detail',
      arguments: [this],
    };
    
    const currentPhase = session.currentRun?.phase ?? 'idle';
    const currentStatus = session.currentRun?.status ?? session.sessionStatus;
    
    this.description = session.currentRun 
      ? `${PHASE_LABELS[currentPhase] ?? currentPhase}${session.queuedRuns > 0 ? ` (+${session.queuedRuns} queued)` : ''}`
      : session.sessionStatus === 'closed' ? 'Closed' : 'Idle';
    
    this.iconPath = sessionIcon(currentPhase, currentStatus, session.sessionStatus);
    this.tooltip = new vscode.MarkdownString(
      `**WI#${session.workItemId}**: ${session.title}\n\n` +
      `**Session Status:** ${session.sessionStatus}  \n` +
      (session.currentRun ? `**Current Run:** ${session.currentRun.type} (${session.currentRun.status})  \n` : '') +
      (session.currentRun?.phase ? `**Phase:** ${PHASE_LABELS[session.currentRun.phase] ?? session.currentRun.phase}  \n` : '') +
      (session.queuedRuns > 0 ? `**Queued Runs:** ${session.queuedRuns}  \n` : '') +
      (session.currentRun?.prUrl ? `**PR:** [View](${session.currentRun.prUrl})  \n` : '') +
      (session.branch ? `**Branch:** \`${session.branch}\`  \n` : '') +
      (session.worktreePath ? `**Worktree:** \`${session.worktreePath}\`` : ''),
    );
  }
}

// Backwards compatibility alias
export { SessionRootNode as PipelineRootNode };

export class PipelineDetailNode extends vscode.TreeItem {
  readonly nodeType = 'detail' as const;
  constructor(label: string, detail: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'pipelineDetail';
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly nodeType = 'message' as const;
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class PipelineProvider implements vscode.TreeDataProvider<PipelineNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PipelineNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly pipelineManager: PipelineManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PipelineNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PipelineNode): PipelineNode[] {
    if (!element) {
      return this.getRootNodes();
    }
    if (element instanceof SessionRootNode) {
      return this.getDetailsFor(element.session);
    }
    return [];
  }

  private getRootNodes(): PipelineNode[] {
    const sessions = this.pipelineManager.getAllSessions();

    if (sessions.length === 0) {
      return [new MessageNode('No active sessions', 'circle-slash')];
    }

    return sessions.map((s) => new SessionRootNode(s));
  }

  private getDetailsFor(session: SessionStatus): PipelineDetailNode[] {
    const details: PipelineDetailNode[] = [];

    details.push(new PipelineDetailNode(
      'Session',
      session.sessionStatus,
      session.sessionStatus === 'active' ? 'circle-filled' : 'circle-outline',
    ));

    if (session.currentRun) {
      details.push(new PipelineDetailNode(
        'Run Type',
        session.currentRun.type,
        'symbol-event',
      ));

      details.push(new PipelineDetailNode(
        'Phase',
        PHASE_LABELS[session.currentRun.phase] ?? session.currentRun.phase,
        PHASE_ICONS[session.currentRun.phase] ?? 'circle-outline',
      ));

      details.push(new PipelineDetailNode(
        'Status',
        session.currentRun.status,
        session.currentRun.status === 'running' ? 'loading~spin' 
          : session.currentRun.status === 'complete' ? 'check' 
          : session.currentRun.status === 'queued' ? 'clock'
          : 'warning',
      ));

      if (session.currentRun.prUrl) {
        details.push(new PipelineDetailNode(
          'PR', 
          session.currentRun.prUrl.split('/').slice(-2).join('/'), 
          'git-pull-request',
        ));
      }
    }

    if (session.branch) {
      details.push(new PipelineDetailNode('Branch', session.branch, 'git-branch'));
    }

    if (session.worktreePath) {
      details.push(new PipelineDetailNode('Worktree', session.worktreePath, 'folder'));
    }

    if (session.queuedRuns > 0) {
      details.push(new PipelineDetailNode('Queued Runs', `${session.queuedRuns}`, 'layers'));
    }

    const elapsed = Math.round((Date.now() - session.lastActivityAt) / 1000);
    details.push(new PipelineDetailNode('Last Activity', formatElapsed(elapsed) + ' ago', 'clock'));

    return details;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionIcon(phase: string, runStatus: string, sessionStatus: string): vscode.ThemeIcon {
  if (sessionStatus === 'closed') {
    return new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.gray'));
  }
  if (runStatus === 'failed') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  if (runStatus === 'complete' || phase === 'complete') {
    return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  }
  if (runStatus === 'paused') {
    return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
  }
  if (runStatus === 'queued') {
    return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.orange'));
  }
  if (runStatus === 'running') {
    return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
  }
  
  // Idle session
  return new vscode.ThemeIcon('circle-outline');
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
