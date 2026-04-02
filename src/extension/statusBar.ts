import * as vscode from 'vscode';
import { PipelineManager } from '../pipeline/manager';

/**
 * Status bar item showing the number of active pipelines.
 * Click to focus the Pipelines panel.
 *
 * Examples:
 *   $(robot) 2 pipelines running
 *   $(robot) No active pipelines
 */
export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private pipelineManager: PipelineManager;

  constructor(pipelineManager: PipelineManager) {
    this.pipelineManager = pipelineManager;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'workbench.view.extension.myworkbuddy';
    this.item.tooltip = 'MyWorkBuddy — Click to open panel';
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const sessions = this.pipelineManager.getAllSessions();
    const active = sessions.filter((s: any) => s.sessionStatus === 'active' && s.currentRun?.status === 'running');

    if (active.length === 0) {
      this.item.text = '$(robot) MyWorkBuddy';
      this.item.backgroundColor = undefined;
    } else {
      const phaseLabel = active.length === 1
        ? formatPhase(active[0].currentRun?.phase ?? 'running')
        : `${active.length} pipelines`;
      this.item.text = `$(loading~spin) ${phaseLabel}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatPhase(phase: string): string {
  const labels: Record<string, string> = {
    wi_review:     'Reviewing WI…',
    init:          'Planning…',
    planning:      'Planning…',
    development:   'Writing code…',
    review:        'Reviewing code…',
    revision:      'Revising…',
    pr_creation:   'Creating PR…',
    pr_monitoring: 'Monitoring PR',
    pr_fix:        'Fixing PR comments…',
    complete:      'Done',
  };
  return labels[phase] ?? phase;
}
