import * as vscode from 'vscode';
import { WorkItemProvider, WorkItemLeafNode } from '../providers/WorkItemProvider';
import { PipelineProvider, SessionRootNode } from '../providers/PipelineProvider';
import { PipelineManager } from '../../pipeline/manager';
import { getConfig } from '../../config/manager';
import { initDb } from '../../db/client';
import { PipelineLogger } from '../pipelineLogger';
import { PipelineDetailPanel } from '../views/PipelineDetailPanel';
import { SettingsPanel } from '../views/SettingsPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  workItemProvider: WorkItemProvider,
  pipelineProvider: PipelineProvider,
  pipelineManager: PipelineManager,
  logger: PipelineLogger,
): vscode.Disposable[] {
  return [
    // ── Work Item View commands ───────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.refreshMyItems', () => {
      workItemProvider.refresh();
    }),

    vscode.commands.registerCommand('myworkbuddy.selectSprint', async () => {
      await workItemProvider.pickSprint();
    }),

    vscode.commands.registerCommand('myworkbuddy.selectTeam', async () => {
      await workItemProvider.pickTeam();
    }),

    vscode.commands.registerCommand('myworkbuddy.openInBrowser', (node: WorkItemLeafNode) => {
      if (node?.workItem?.url) {
        vscode.env.openExternal(vscode.Uri.parse(node.workItem.url));
      }
    }),

    // ── Workflow commands ─────────────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.startWorkflow', async (node: WorkItemLeafNode) => {
      if (!(node instanceof WorkItemLeafNode)) {
        vscode.window.showErrorMessage('Please right-click a work item to start a workflow');
        return;
      }

      const wi = node.workItem;
      const cfg = getConfig().getAll();

      if (!getConfig().isConfigured()) {
        const action = await vscode.window.showErrorMessage(
          'MyWorkBuddy is not configured.',
          'Open Terminal to configure',
        );
        if (action) {
          vscode.commands.executeCommand('workbench.action.terminal.new');
        }
        return;
      }

      // Check if session is already active
      const existingStatus = pipelineManager.getSessionStatus(
        // We don't have sessionId here, need to check by workItemId
        // For now, use getAllSessions to find it
        ...pipelineManager.getAllSessions().filter(s => s.workItemId === wi.id).map(s => s.sessionId)
      );

      if (existingStatus && pipelineManager.isSessionActive(existingStatus.sessionId)) {
        const action = await vscode.window.showWarningMessage(
          `A pipeline for WI#${wi.id} is already running.`,
          'Stop & Restart',
          'Queue Another Run',
          'Dismiss',
        );
        if (action === 'Stop & Restart') {
          pipelineManager.stopRun(existingStatus.sessionId);
        } else if (action === 'Queue Another Run') {
          // Fall through to start, it will queue
        } else {
          return;
        }
      }

      const confirm = await vscode.window.showInformationMessage(
        `Start AI workflow for WI#${wi.id}: "${wi.title}"?`,
        { modal: true },
        'Start',
      );
      if (confirm !== 'Start') return;

      // Ensure DB is ready before starting
      try {
        await initDb();
      } catch (err: any) {
        vscode.window.showErrorMessage(`DB init failed: ${err.message}`);
        return;
      }

      // Resolve the local repo path
      let repoLocalPath: string | undefined;
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length === 1) {
        repoLocalPath = workspaceFolders[0].uri.fsPath;
      } else if (workspaceFolders && workspaceFolders.length > 1) {
        const pick = await vscode.window.showQuickPick(
          workspaceFolders.map((f) => ({ label: f.name, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
          { title: 'Select the local repo folder for this pipeline', ignoreFocusOut: true },
        );
        repoLocalPath = pick?.fsPath;
        if (!repoLocalPath) return;
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: 'Select local repo folder (the git repo to commit code into)',
        });
        repoLocalPath = picked?.[0]?.fsPath;
        if (!repoLocalPath) return;
      }

      try {
        const detailPanel = PipelineDetailPanel.createOrShow(wi.id, wi.title, context);
        
        const { sessionId, runId } = await pipelineManager.startRun(wi.id, {
          adoOrg: cfg.ado.orgUrl,
          project: cfg.ado.wiProject,
          repo: cfg.ado.defaultRepo,
          title: wi.title,
          repoLocalPath,
          triggeredBy: 'user',
        }, detailPanel.awaitConfirmation.bind(detailPanel),
           detailPanel.awaitBlueprintConfirmation.bind(detailPanel));

        logger.create(wi.id, wi.title);
        vscode.window.showInformationMessage(
          `Pipeline started for WI#${wi.id} (Session: ${sessionId}, Run: ${runId}).`,
          'Show Logs',
        ).then((action) => { if (action === 'Show Logs') logger.show(wi.id); });
        pipelineProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to start pipeline: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('myworkbuddy.showLogs', (node: SessionRootNode) => {
      if (node?.session?.workItemId) {
        logger.show(node.session.workItemId);
      }
    }),

    vscode.commands.registerCommand('myworkbuddy.stopPipeline', async (node: SessionRootNode) => {
      if (!(node instanceof SessionRootNode)) {
        vscode.window.showErrorMessage('Please right-click a running session to stop it');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Stop all runs for WI#${node.session.workItemId}?`,
        { modal: true },
        'Stop',
      );
      if (confirm !== 'Stop') return;

      pipelineManager.stopRun(node.session.sessionId);
      pipelineProvider.refresh();
      vscode.window.showInformationMessage(`Session for WI#${node.session.workItemId} stopped.`);
    }),

    // ── Close session command ─────────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.closeSession', async (node: SessionRootNode) => {
      if (!(node instanceof SessionRootNode)) return;

      const confirm = await vscode.window.showWarningMessage(
        `Close session for WI#${node.session.workItemId}? This will stop all runs and mark the session as closed.`,
        { modal: true },
        'Close',
      );
      if (confirm !== 'Close') return;

      pipelineManager.closeSession(node.session.sessionId, 'manual');
      pipelineProvider.refresh();
      vscode.window.showInformationMessage(`Session for WI#${node.session.workItemId} closed.`);
    }),

    // ── Worktree command ──────────────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.openWorktree', async (node: SessionRootNode) => {
      const worktreePath = node?.session?.worktreePath;
      if (!worktreePath) {
        vscode.window.showWarningMessage('No worktree available for this session yet. Wait until planning is complete.');
        return;
      }

      const uri = vscode.Uri.file(worktreePath);
      const action = await vscode.window.showInformationMessage(
        `Open worktree for WI#${node.session.workItemId} in a new window?`,
        'New Window',
        'Add to Workspace',
      );

      if (action === 'New Window') {
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      } else if (action === 'Add to Workspace') {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          null,
          { uri, name: `WI#${node.session.workItemId} — ${node.session.title}` },
        );
      }
    }),

    // ── Settings panel ───────────────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.openSettings', () => {
      SettingsPanel.createOrShow(context);
    }),

    // ── Pipeline detail panel ─────────────────────────────────────────────────

    vscode.commands.registerCommand('myworkbuddy.openPipelineDetail', (node: SessionRootNode) => {
      if (!(node instanceof SessionRootNode)) return;
      PipelineDetailPanel.createOrShow(node.session.workItemId, node.session.title, context);
    }),
  ];
}
