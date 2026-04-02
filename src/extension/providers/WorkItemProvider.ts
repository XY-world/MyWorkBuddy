import * as vscode from 'vscode';
import {
  AdoWorkItem,
  getMyWorkItemsForIteration,
  getWorkItemsForIteration,
  getIterations,
  getTeams,
} from '../../ado/work-items';
import { getConfig } from '../../config/manager';

// ── Tree node types ──────────────────────────────────────────────────────────

export type WorkItemNode = SprintHeaderNode | WorkItemLeafNode | MessageNode;

export class SprintHeaderNode extends vscode.TreeItem {
  readonly nodeType = 'sprint' as const;
  constructor(public readonly sprintName: string, public readonly iterationPath: string) {
    super(sprintName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'sprint';
    this.iconPath = new vscode.ThemeIcon('calendar');
  }
}

export class WorkItemLeafNode extends vscode.TreeItem {
  readonly nodeType = 'workItem' as const;
  constructor(public readonly workItem: AdoWorkItem) {
    super(workItem.title, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'workItem';
    this.description = `#${workItem.id} · ${workItem.state}`;
    this.tooltip = new vscode.MarkdownString(
      `**WI#${workItem.id}**: ${workItem.title}\n\n` +
      `**State:** ${workItem.state}  \n` +
      `**Type:** ${workItem.type}  \n` +
      `**Assigned:** ${workItem.assignedTo || 'Unassigned'}  \n` +
      (workItem.storyPoints ? `**Story Points:** ${workItem.storyPoints}` : ''),
    );
    this.iconPath = workItemIcon(workItem.type, workItem.state);
    if (workItem.url) {
      this.command = {
        command: 'myworkbuddy.openInBrowser',
        title: 'Open in Browser',
        arguments: [this],
      };
    }
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly nodeType = 'message' as const;
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class WorkItemProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private selectedTeam: string | null = null;
  private selectedIterationPath: string | null = null;
  private showOnlyMine = true;

  // Cache to avoid re-fetching on every expand
  private cache = new Map<string, AdoWorkItem[]>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // Restore persisted selections
    this.selectedTeam = context.globalState.get('myworkbuddy.selectedTeam') ?? null;
    this.selectedIterationPath = context.globalState.get('myworkbuddy.selectedIteration') ?? null;
    this.showOnlyMine = context.globalState.get('myworkbuddy.showOnlyMine') ?? true;
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkItemNode): Promise<WorkItemNode[]> {
    if (!element) {
      return this.getRootNodes();
    }
    if (element instanceof SprintHeaderNode) {
      return this.getWorkItemsForSprint(element.iterationPath);
    }
    return [];
  }

  // ── Selection helpers ──────────────────────────────────────────────────────

  async pickTeam(): Promise<void> {
    const cfg = getConfig().getAll();
    let teams: Array<{ id: string; name: string }>;
    try {
      teams = await getTeams(cfg.ado.wiProject);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load teams: ${err.message}`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      teams.map((t) => ({ label: t.name, description: t.id })),
      { placeHolder: 'Select team', title: 'MyWorkBuddy: Select Team' },
    );
    if (!picked) return;

    this.selectedTeam = picked.label;
    await this.context.globalState.update('myworkbuddy.selectedTeam', this.selectedTeam);
    this.refresh();
  }

  async pickSprint(): Promise<void> {
    const cfg = getConfig().getAll();
    let iterations: Array<{ id: string; name: string; path: string; isCurrent: boolean }>;
    try {
      iterations = await getIterations(cfg.ado.wiProject);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load sprints: ${err.message}`);
      return;
    }

    const items = iterations.map((it) => ({
      label: it.name + (it.isCurrent ? ' $(star-full)' : ''),
      description: it.path,
      iterationPath: it.path,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select sprint / iteration',
      title: 'MyWorkBuddy: Select Sprint',
    });
    if (!picked) return;

    this.selectedIterationPath = picked.iterationPath;
    await this.context.globalState.update('myworkbuddy.selectedIteration', this.selectedIterationPath);
    this.refresh();
  }

  getSelectedIterationPath(): string | null {
    return this.selectedIterationPath;
  }

  getSelectedTeam(): string | null {
    return this.selectedTeam;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getRootNodes(): Promise<WorkItemNode[]> {
    const cfg = getConfig();
    if (!cfg.isConfigured()) {
      return [new MessageNode('MyWorkBuddy is not configured. Run: myworkbuddy init', 'warning')];
    }

    if (!this.selectedIterationPath) {
      // Auto-select current sprint on first load
      try {
        const iterations = await getIterations(cfg.getAll().ado.wiProject);
        const current = iterations.find((it) => it.isCurrent) ?? iterations[0];
        if (current) {
          this.selectedIterationPath = current.path;
          await this.context.globalState.update('myworkbuddy.selectedIteration', this.selectedIterationPath);
        }
      } catch { /* ignore — will show error in items */ }
    }

    if (!this.selectedIterationPath) {
      return [new MessageNode('Click $(calendar) to select a sprint', 'calendar')];
    }

    const sprintName = this.selectedIterationPath.split('\\').pop() ?? this.selectedIterationPath;
    const header = this.selectedTeam
      ? `${sprintName} — ${this.selectedTeam}`
      : sprintName;

    return [new SprintHeaderNode(header, this.selectedIterationPath)];
  }

  private async getWorkItemsForSprint(iterationPath: string): Promise<WorkItemNode[]> {
    const cfg = getConfig().getAll();
    const cacheKey = `${iterationPath}:${this.showOnlyMine}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!.map((wi) => new WorkItemLeafNode(wi));
    }

    try {
      const items = this.showOnlyMine
        ? await getMyWorkItemsForIteration(cfg.ado.wiProject, iterationPath)
        : await getWorkItemsForIteration(cfg.ado.wiProject, iterationPath);

      this.cache.set(cacheKey, items);

      if (items.length === 0) {
        return [new MessageNode('No work items found for this sprint', 'info')];
      }

      return items.map((wi) => new WorkItemLeafNode(wi));
    } catch (err: any) {
      return [new MessageNode(`Error loading work items: ${err.message}`, 'error')];
    }
  }
}

// ── Icon helper ───────────────────────────────────────────────────────────────

function workItemIcon(type: string, state: string): vscode.ThemeIcon {
  const t = type.toLowerCase();
  const s = state.toLowerCase();

  // State-based color
  let color: string | undefined;
  if (s === 'active' || s === 'in progress') color = 'charts.blue';
  else if (s === 'resolved' || s === 'in review') color = 'charts.purple';
  else if (s === 'closed' || s === 'done') color = 'charts.green';
  else if (s === 'new') color = 'charts.yellow';

  // Type-based icon
  let icon = 'circle-outline';
  if (t.includes('bug')) icon = 'bug';
  else if (t.includes('feature') || t.includes('user story')) icon = 'star';
  else if (t.includes('task')) icon = 'tasklist';
  else if (t.includes('epic')) icon = 'rocket';
  else if (t.includes('test')) icon = 'beaker';

  return color
    ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color))
    : new vscode.ThemeIcon(icon);
}
