import * as vscode from 'vscode';
import { PipelineManager, PipelineStatus } from '../../pipeline/manager';
import { Phase } from '../../memory/session';

// ── Tree node types ──────────────────────────────────────────────────────────

export type PipelineNode = PipelineRootNode | PipelineDetailNode | MessageNode;

const PHASE_ICONS: Record<Phase | string, string> = {
  wi_review:     'search',
  init:          'person',
  planning:      'list-ordered',
  development:   'code',
  review:        'eye',
  revision:      'refresh',
  pr_creation:   'git-pull-request',
  pr_monitoring: 'bell',
  pr_fix:        'tools',
  complete:      'check',
};

const PHASE_LABELS: Record<Phase | string, string> = {
  wi_review:     'WI Review',
  init:          'Planning',
  planning:      'Planning',
  development:   'Development',
  review:        'Code Review',
  revision:      'Revision',
  pr_creation:   'Creating PR',
  pr_monitoring: 'Monitoring PR',
  pr_fix:        'Fixing PR Comments',
  complete:      'Complete',
};

export class PipelineRootNode extends vscode.TreeItem {
  readonly nodeType = 'pipeline' as const;
  constructor(public readonly pipeline: PipelineStatus) {
    super(
      `WI#${pipeline.workItemId}: ${pipeline.title || 'Loading...'}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = 'pipeline';
    this.command = {
      command: 'myworkbuddy.openPipelineDetail',
      title: 'Open Pipeline Detail',
      arguments: [this],
    };
    this.description = PHASE_LABELS[pipeline.phase] ?? pipeline.phase;
    this.iconPath = phaseIcon(pipeline.phase, pipeline.status);
    this.tooltip = new vscode.MarkdownString(
      `**WI#${pipeline.workItemId}**: ${pipeline.title}\n\n` +
      `**Phase:** ${PHASE_LABELS[pipeline.phase] ?? pipeline.phase}  \n` +
      `**Status:** ${pipeline.status}  \n` +
      (pipeline.prUrl ? `**PR:** [View](${pipeline.prUrl})  \n` : '') +
      (pipeline.worktreePath ? `**Worktree:** \`${pipeline.worktreePath}\`` : ''),
    );
  }
}

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
    if (element instanceof PipelineRootNode) {
      return this.getDetailsFor(element.pipeline);
    }
    return [];
  }

  private getRootNodes(): PipelineNode[] {
    const pipelines = this.pipelineManager.getAll();

    if (pipelines.length === 0) {
      return [new MessageNode('No active pipelines', 'circle-slash')];
    }

    return pipelines.map((p) => new PipelineRootNode(p));
  }

  private getDetailsFor(pipeline: PipelineStatus): PipelineDetailNode[] {
    const details: PipelineDetailNode[] = [];

    details.push(new PipelineDetailNode(
      'Phase',
      PHASE_LABELS[pipeline.phase] ?? pipeline.phase,
      PHASE_ICONS[pipeline.phase] ?? 'circle-outline',
    ));

    details.push(new PipelineDetailNode(
      'Status',
      pipeline.status,
      pipeline.status === 'active' ? 'loading~spin' : pipeline.status === 'complete' ? 'check' : 'warning',
    ));

    if (pipeline.prUrl) {
      details.push(new PipelineDetailNode('PR', pipeline.prUrl.split('/').slice(-2).join('/'), 'git-pull-request'));
    }

    if (pipeline.worktreePath) {
      details.push(new PipelineDetailNode('Worktree', pipeline.worktreePath, 'folder'));
    }

    const elapsed = Math.round((Date.now() - pipeline.startedAt) / 1000);
    details.push(new PipelineDetailNode('Running', formatElapsed(elapsed), 'clock'));

    if (pipeline.lastEvent) {
      const ev = pipeline.lastEvent as any;
      const label = ev.type === 'task_update' ? `${ev.status}: ${ev.message?.slice(0, 40)}` : ev.type;
      details.push(new PipelineDetailNode('Last Event', label, 'pulse'));
    }

    return details;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function phaseIcon(phase: string, status: string): vscode.ThemeIcon {
  if (status === 'failed') return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  if (status === 'complete') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  if (status === 'paused') return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));

  const icon = PHASE_ICONS[phase] ?? 'loading~spin';
  return status === 'active'
    ? new vscode.ThemeIcon(icon === 'loading~spin' ? icon : 'loading~spin', new vscode.ThemeColor('charts.blue'))
    : new vscode.ThemeIcon(icon);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
