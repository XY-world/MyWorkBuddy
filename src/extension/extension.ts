import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { WorkItemProvider } from './providers/WorkItemProvider';
import { PipelineProvider } from './providers/PipelineProvider';
import { StatusBarManager } from './statusBar';
import { registerCommands } from './commands';
import { getPipelineManager } from '../pipeline/manager';
import { getConfig } from '../config/manager';
import { initDb, disposeDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { setVscodeLm } from '../tools/copilot-client';
import { PipelineLogger } from './pipelineLogger';
import { PipelineDetailPanel } from './views/PipelineDetailPanel';

export function activate(context: vscode.ExtensionContext): void {
  // Wire VSCode LM API so agents use Copilot directly (no gh CLI subprocess needed).
  // vscode.lm is available as long as GitHub Copilot extension is installed & signed in.
  if (vscode.lm) {
    setVscodeLm(
      vscode.lm as any,
      (content) => vscode.LanguageModelChatMessage.User(content) as any,
      (content) => vscode.LanguageModelChatMessage.Assistant(content) as any,
    );
  } else {
    vscode.window.showWarningMessage(
      'MyWorkBuddy: GitHub Copilot is not available. Install the GitHub Copilot extension and sign in.',
    );
  }

  // Initialize DB async before anything else; show error if it fails
  initDb().then(() => {
    runMigrations();
  }).catch((err) => {
    vscode.window.showErrorMessage(`MyWorkBuddy: DB init failed — ${err.message}`);
  });

  const pipelineManager = getPipelineManager();

  // Tree data providers
  const workItemProvider = new WorkItemProvider(context);
  const pipelineProvider = new PipelineProvider(pipelineManager);

  // Register tree views
  const workItemsTree = vscode.window.createTreeView('myworkbuddy.workItems', {
    treeDataProvider: workItemProvider,
    showCollapseAll: true,
  });

  const pipelinesTree = vscode.window.createTreeView('myworkbuddy.pipelines', {
    treeDataProvider: pipelineProvider,
    showCollapseAll: false,
  });

  // Status bar
  const statusBar = new StatusBarManager(pipelineManager);

  const logger = new PipelineLogger();

  // Register all commands (pass logger so showLogs command can use it)
  const commandDisposables = registerCommands(context, workItemProvider, pipelineProvider, pipelineManager, logger);

  // Auto-refresh pipeline panel every 5s while pipelines are active (keeps timer ticking)
  const refreshTimer = setInterval(() => {
    if (pipelineManager.getAll().length > 0) {
      pipelineProvider.refresh();
      statusBar.refresh();
    }
  }, 5000);

  // Forward pipeline events → logger + detail panel + sidebar refresh
  pipelineManager.on('pipeline_event', (workItemId: number, event: unknown) => {
    const e = event as any;
    logger.log(workItemId, e);

    // Forward to detail panel (if open) and sync worktree path
    const detailPanel = PipelineDetailPanel.getPanel(workItemId);
    if (detailPanel) {
      detailPanel.handleEvent(e);
      const status = pipelineManager.getAll().find((p) => p.workItemId === workItemId);
      if (status?.worktreePath) detailPanel.setWorktreePath(status.worktreePath);
    }

    pipelineProvider.refresh();
    statusBar.refresh();

    // WI Review blocked — wire the panel's "Proceed Anyway" button
    if (e.type === 'wi_review_blocked') {
      const dp = PipelineDetailPanel.getPanel(workItemId);
      if (dp) {
        dp.proceedAnywayCallback = () => {
          dp.proceedAnywayCallback = undefined;
          const orch = pipelineManager.getOrchestrator(workItemId);
          if (orch) {
            orch.forceResumeFromWiReview().catch((err) => {
              vscode.window.showErrorMessage(`Resume failed: ${err.message}`);
            });
          }
        };
      }
    }
  });
  pipelineManager.on('pipeline_started', (workItemId: number) => {
    const title = pipelineManager.getAll().find((p) => p.workItemId === workItemId)?.title ?? '';
    logger.create(workItemId, title);
    pipelineProvider.refresh();
    statusBar.refresh();
  });
  pipelineManager.on('pipeline_stopped', (workItemId: number) => {
    logger.log(workItemId, { type: 'error', message: 'Pipeline stopped by user', phase: 'complete' });
    pipelineProvider.refresh();
    statusBar.refresh();
  });
  pipelineManager.on('pipeline_error', (workItemId: number, message: string) => {
    logger.logError(workItemId, message);
    logger.show(workItemId); // auto-open log on error
    vscode.window.showErrorMessage(
      `Pipeline for WI#${workItemId} failed: ${message}`,
      'Show Logs',
    ).then((action) => {
      if (action === 'Show Logs') logger.show(workItemId);
    });
    pipelineProvider.refresh();
    statusBar.refresh();
  });

  context.subscriptions.push(
    workItemsTree,
    pipelinesTree,
    statusBar,
    ...commandDisposables,
    new vscode.Disposable(() => { clearInterval(refreshTimer); }),
    new vscode.Disposable(() => pipelineManager.dispose()),
    new vscode.Disposable(() => logger.disposeAll()),
    new vscode.Disposable(() => disposeDb()),
  );

  // Run startup checks asynchronously so activation is not blocked
  runStartupChecks(workItemProvider).catch(() => { /* never throws */ });
}

export function deactivate(): void {
  // PipelineManager.dispose() is called via subscription above
}

// ── Startup checks ────────────────────────────────────────────────────────────

async function runStartupChecks(workItemProvider: WorkItemProvider): Promise<void> {
  // Check 1: az CLI installed
  if (!isAzCliInstalled()) {
    const action = await vscode.window.showErrorMessage(
      'MyWorkBuddy: Azure CLI (az) is not installed. It is required for Azure DevOps authentication.',
      'Install Azure CLI',
    );
    if (action === 'Install Azure CLI') {
      vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/installazurecli'));
    }
    return; // No point checking login if az isn't installed
  }

  // Check 2: az login
  if (!isAzLoggedIn()) {
    const action = await vscode.window.showWarningMessage(
      'MyWorkBuddy: You are not logged in to Azure. Please run "az login" to authenticate.',
      'az login',
      'Dismiss',
    );
    if (action === 'az login') {
      runAzLoginInTerminal();
    }
    return;
  }

  // Check 3: myworkbuddy configured
  if (!getConfig().isConfigured()) {
    const action = await vscode.window.showWarningMessage(
      'MyWorkBuddy is not configured yet. Run the setup wizard to connect to Azure DevOps.',
      'Run Setup',
      'Dismiss',
    );
    if (action === 'Run Setup') {
      const terminal = vscode.window.createTerminal('MyWorkBuddy Setup');
      terminal.show();
      terminal.sendText('npx ts-node src/cli/index.ts init');
    }
    return;
  }

  // All checks passed — silently refresh work items
  workItemProvider.refresh();
}

function isAzCliInstalled(): boolean {
  try {
    execSync('az --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAzLoggedIn(): boolean {
  try {
    execSync('az account show', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runAzLoginInTerminal(): void {
  const terminal = vscode.window.createTerminal('Azure Login');
  terminal.show();
  terminal.sendText('az login');
  // After login completes the user can click Refresh in the Work Items panel
  vscode.window.showInformationMessage(
    'After login completes, click $(refresh) in the Work Items panel to load your work items.',
  );
}
