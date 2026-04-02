import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SseEvent, PhaseCompleteSummary } from '../../agents/orchestrator';
import { ManagerAgent, ChatMessage, PipelineBlueprint, VsAction } from '../../agents/manager-agent';
import { getChangedFilesVsBranch, getFileContentAtRef } from '../../tools/git-tools';
import { getMessages, addMessage, ChatMessage as DbChatMessage } from '../../memory/chat';
import { getOrCreateSession } from '../../memory/session';

// ── State types ──────────────────────────────────────────────────────────────

interface PhaseEntry {
  phase: string;
  label: string;
  agentPersona: string;
  /** pending | running | awaiting | complete | failed | blocked */
  status: string;
  startedAt?: number;
  completedAt?: number;
  headline?: string;
  details?: string[];
  tasks: { id: number; message: string; status: string }[];
}

interface PanelState {
  workItemId: number;
  title: string;
  sessionStatus: string;
  phases: PhaseEntry[];
  chat: ChatMessage[];
  devComplete: boolean;
  worktreePath: string;
  baseBranch: string;
  prUrl: string;
  pendingPhase?: string;   // phase awaiting user decision
  samThinking: boolean;    // Sam is generating a reply
}

// ── Constants ────────────────────────────────────────────────────────────────

const PHASE_ORDER = [
  'wi_review', 'init', 'planning', 'development',
  'review', 'revision', 'pr_creation', 'pr_monitoring', 'pr_fix',
  'investigation', 'draft_comment', 'post_comment',
  'complete',
];

const PHASE_LABELS: Record<string, string> = {
  wi_review:     'WI Review',
  init:          'Planning',
  planning:      'Planning',
  development:   'Development',
  review:        'Code Review',
  revision:      'Revision',
  pr_creation:   'Creating PR',
  pr_monitoring: 'Monitoring PR',
  pr_fix:        'Fixing Comments',
  investigation: 'Investigation',
  draft_comment: 'Draft Findings',
  post_comment:  'Post to ADO',
  complete:      'Complete',
};

const PHASE_AGENT: Record<string, string> = {
  wi_review:     'Riley',
  init:          'Alex',
  planning:      'Alex',
  development:   'Morgan',
  review:        'Jordan',
  revision:      'Morgan',
  pr_fix:        'Morgan',
  investigation: 'Alex',
  draft_comment: 'Alex',
  post_comment:  'Sam',
};

// ── Panel class ──────────────────────────────────────────────────────────────

export class PipelineDetailPanel {
  private static panels = new Map<number, PipelineDetailPanel>();

  private readonly panel: vscode.WebviewPanel;
  private htmlInitialized = false;
  private manager: ManagerAgent;

  // Session tracking
  private sessionId: number | null = null;

  // Timeline state
  private phases = new Map<string, PhaseEntry>();
  private currentPhase = '';
  private sessionStatus = 'active';
  private devComplete = false;
  private worktreePath = '';
  private baseBranch = 'main';
  private prUrl = '';

  // Chat state
  private chatHistory: ChatMessage[] = [];
  private pendingPhase?: string;
  private samThinking = false;
  private confirmResolve?: (result: string) => void;

  // Pending blueprint confirmation
  private blueprintResolve?: (blueprint: PipelineBlueprint) => void;
  private pendingBlueprint?: PipelineBlueprint;

  // Callbacks wired from outside
  public proceedAnywayCallback?: () => void;

  private constructor(
    private readonly workItemId: number,
    private readonly title: string,
    _context: vscode.ExtensionContext,
  ) {
    this.manager = new ManagerAgent();

    this.panel = vscode.window.createWebviewPanel(
      'myworkbuddy.pipelineDetail',
      `Pipeline · WI#${workItemId}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    for (const phase of PHASE_ORDER) {
      this.phases.set(phase, {
        phase,
        label: PHASE_LABELS[phase] ?? phase,
        agentPersona: PHASE_AGENT[phase] ?? '',
        status: 'pending',
        tasks: [],
      });
    }

    this.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'chat':
          this.handleUserChat(msg.text?.trim());
          break;
        case 'proceedAnyway':
          this.proceedAnywayCallback?.();
          break;
        case 'reviewCode':
          this.openCodeReview();
          break;
        case 'openInVscode':
          if (this.worktreePath && fs.existsSync(this.worktreePath)) {
            vscode.commands.executeCommand(
              'vscode.openFolder',
              vscode.Uri.file(this.worktreePath),
              { forceNewWindow: true },
            );
          }
          break;
        case 'openUrl':
          if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
      }
    });

    this.panel.onDidDispose(() => {
      PipelineDetailPanel.panels.delete(workItemId);
      this.confirmResolve?.('continue');
      this.confirmResolve = undefined;
    });

    // Sam introduces himself
    this.addSamMessage(`Hi! I'm Sam, your Engineering Manager for WI#${workItemId}. I'll coordinate the team and keep you updated. The pipeline is starting now.`);
    this.push();
  }

  // ── Static factory ───────────────────────────────────────────────────────────

  static createOrShow(workItemId: number, title: string, context: vscode.ExtensionContext): PipelineDetailPanel {
    const existing = PipelineDetailPanel.panels.get(workItemId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return existing;
    }
    const p = new PipelineDetailPanel(workItemId, title, context);
    PipelineDetailPanel.panels.set(workItemId, p);
    return p;
  }

  static getPanel(workItemId: number): PipelineDetailPanel | undefined {
    return PipelineDetailPanel.panels.get(workItemId);
  }

  // ── Event handling ───────────────────────────────────────────────────────────

  handleEvent(event: SseEvent): void {
    switch (event.type) {

      case 'blueprint_ready': {
        this.pendingBlueprint = event.blueprint;
        // Sam announces the plan — already done by ManagerAgent, just push state
        this.push();
        break;
      }

      case 'phase_change': {
        this.currentPhase = event.phase;
        for (const e of this.phases.values()) {
          if (e.status === 'running') { e.status = 'complete'; e.completedAt = Date.now(); }
        }
        const entry = this.phases.get(event.phase);
        if (entry) { entry.status = 'running'; entry.startedAt = Date.now(); }
        // Sam narrates the new phase starting
        const label = PHASE_LABELS[event.phase] ?? event.phase;
        const agent = PHASE_AGENT[event.phase];
        if (agent && event.phase !== 'complete') {
          this.addSamMessage(`${agent} is starting the ${label} phase…`);
        }
        break;
      }

      case 'phase_complete': {
        const s = event.summary;
        const entry = this.phases.get(s.phase);
        if (entry) {
          entry.status = 'awaiting';
          entry.headline = s.headline;
          entry.details = s.details;
          if (!entry.startedAt) entry.startedAt = Date.now();
          entry.completedAt = Date.now();
        }
        if (s.phase === 'development') this.devComplete = true;
        // Sam announces — async, don't block
        this.samAnnouncePhase(s);
        break;
      }

      case 'task_update': {
        const dev = this.phases.get('development');
        if (!dev) break;
        const existing = dev.tasks.find((t) => t.id === event.taskId);
        if (existing) {
          existing.status = event.status;
          existing.message = event.message;
        } else {
          dev.tasks.push({ id: event.taskId, status: event.status, message: event.message });
        }
        break;
      }

      case 'wi_review_result': {
        const e = this.phases.get('wi_review');
        if (e) {
          e.headline = `${event.feasible ? 'Feasible' : 'Not feasible'} · ${event.complexity} complexity`;
          e.details = event.risks.map((r) => `⚠ ${r}`);
        }
        break;
      }

      case 'wi_review_blocked': {
        const e = this.phases.get('wi_review');
        if (e) {
          e.status = 'blocked';
          e.details = event.blockers.map((b) => `✖ ${b}`);
          e.completedAt = Date.now();
        }
        this.sessionStatus = 'paused';
        this.addSamMessage(
          `Riley flagged a concern: ${event.blockers.join('; ')}\n\nYou can click **Proceed Anyway** to continue despite this, or reply here with more context and I'll relay it to the team.`,
        );
        break;
      }

      case 'review_result': {
        const e = this.phases.get('review');
        if (e) {
          e.headline = `${event.approved ? 'Approved' : 'Changes requested'} · score ${event.score}/10`;
        }
        break;
      }

      case 'pr_created': {
        this.prUrl = event.prUrl;
        const e = this.phases.get('pr_creation');
        if (e) { e.status = 'complete'; e.headline = event.prUrl; e.completedAt = Date.now(); }
        this.addSamMessage(`PR created: ${event.prUrl}\n\nI'm now monitoring for reviewer comments and will auto-fix them when they arrive.`);
        this.pendingPhase = undefined;
        break;
      }

      case 'run_complete': {
        this.sessionStatus = 'complete';
        const e = this.phases.get('complete');
        if (e) { e.status = 'complete'; e.completedAt = Date.now(); }
        this.addSamMessage('Pipeline complete! The team has finished. Let me know if you need anything else.');
        this.pendingPhase = undefined;
        break;
      }

      case 'agent_complete': {
        // Silently update timeline, Sam handles the narrative via phase_complete
        break;
      }

      case 'error': {
        const e = this.phases.get(event.phase);
        if (e) { e.status = 'failed'; e.completedAt = Date.now(); }
        this.sessionStatus = 'failed';
        this.addSamMessage(`⚠ The pipeline hit an error in ${PHASE_LABELS[event.phase] ?? event.phase}: ${event.message}`);
        this.pendingPhase = undefined;
        this.confirmResolve?.('stop');
        this.confirmResolve = undefined;
        break;
      }
    }

    this.push();
  }

  setWorktreePath(p: string): void {
    if (p && p !== this.worktreePath) { this.worktreePath = p; this.push(); }
  }

  // ── Blueprint confirmation ───────────────────────────────────────────────────

  async awaitBlueprintConfirmation(blueprint: PipelineBlueprint, announcement: string): Promise<PipelineBlueprint> {
    this.pendingBlueprint = blueprint;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.addSamMessage(
      announcement + '\n\n' +
      `**Proposed pipeline (${blueprint.type}):**\n` +
      blueprint.stages.map((s, i) => `${i + 1}. ${s.label} — ${s.agentPersona}`).join('\n') +
      '\n\nReply **"ok"** to start, or tell me if you want a different approach.',
    );
    this.push();

    return new Promise<PipelineBlueprint>((resolve) => {
      this.blueprintResolve = resolve;
    });
  }

  // ── Phase confirmation (Sam-mediated) ────────────────────────────────────────

  async awaitConfirmation(summary: PhaseCompleteSummary): Promise<'continue' | 'stop' | string> {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.pendingPhase = summary.phase;
    this.push();
    return new Promise<string>((resolve) => {
      this.confirmResolve = resolve;
    }) as Promise<'continue' | 'stop' | string>;
  }

  // ── Chat handling ─────────────────────────────────────────────────────────────

  private async handleUserChat(text: string | undefined): Promise<void> {
    if (!text) return;
    this.addUserMessage(text);
    this.samThinking = true;
    this.push();

    try {
      // Blueprint negotiation phase
      if (this.blueprintResolve && this.pendingBlueprint) {
        const result = await this.manager.refinePlan(text, this.pendingBlueprint, { id: this.workItemId, title: this.title } as any);
        if (!result) {
          // User confirmed as-is
          this.addSamMessage("Great — starting the pipeline now.");
          const bp = this.pendingBlueprint;
          this.pendingBlueprint = undefined;
          this.blueprintResolve(bp);
          this.blueprintResolve = undefined;
        } else {
          this.addSamMessage(result.reply);
          if (result.blueprint !== this.pendingBlueprint) {
            this.pendingBlueprint = result.blueprint;
            // If Sam changed the plan and it looks final, auto-confirm
            const looksLikeFinal = /^(ok|yes|sure|go|start|proceed)/i.test(result.reply);
            if (looksLikeFinal) {
              const bp = this.pendingBlueprint;
              this.pendingBlueprint = undefined;
              this.blueprintResolve!(bp);
              this.blueprintResolve = undefined;
            }
          }
        }
      } else {
        // Normal phase chat
        const pipelineContext = this.buildPipelineContext();
        const decision = await this.manager.processMessage(
          text, this.pendingPhase, this.chatHistory, pipelineContext,
        );
        this.addSamMessage(decision.reply);

        // Execute VSCode action if Sam triggered one
        if (decision.vsAction) {
          this.executeVsAction(decision.vsAction);
        }

        if (decision.action === 'continue') {
          this.pendingPhase = undefined;
          this.confirmResolve?.('continue');
          this.confirmResolve = undefined;
        } else if (decision.action === 'stop') {
          this.pendingPhase = undefined;
          this.confirmResolve?.('stop');
          this.confirmResolve = undefined;
        } else if (decision.action === 'feedback' && decision.feedback) {
          this.addSamMessage(`Passing to the team: "${decision.feedback}"`);
          this.pendingPhase = undefined;
          this.confirmResolve?.(decision.feedback);
          this.confirmResolve = undefined;
        }
      }
    } catch {
      this.addSamMessage('(No response from Sam — try again)');
    }

    this.samThinking = false;
    this.push();
  }

  private async samAnnouncePhase(summary: PhaseCompleteSummary): Promise<void> {
    this.samThinking = true;
    this.push();
    try {
      const announcement = await this.manager.announcePhaseComplete(summary, this.chatHistory);
      this.addSamMessage(announcement);
    } catch {
      // Fallback plain message
      this.addSamMessage(`${summary.agentPersona} finished: ${summary.headline}. Ready to proceed to ${summary.nextPhase?.replace(/_/g, ' ') ?? 'next phase'}?`);
    }
    this.samThinking = false;
    this.push();
  }

  private addSamMessage(text: string): void {
    this.chatHistory.push({ role: 'sam', text, timestamp: Date.now() });
    // Persist to database if session is known
    if (this.sessionId) {
      addMessage(this.sessionId, 'assistant', text);
    }
  }

  private addUserMessage(text: string): void {
    this.chatHistory.push({ role: 'user', text, timestamp: Date.now() });
    // Persist to database if session is known
    if (this.sessionId) {
      addMessage(this.sessionId, 'user', text);
    }
  }

  /** Set the session ID and load chat history from database */
  setSessionId(sessionId: number): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.loadChatHistory();
  }

  private loadChatHistory(): void {
    if (!this.sessionId) return;
    try {
      const dbMessages = getMessages(this.sessionId);
      // Convert DB format to panel format
      this.chatHistory = dbMessages
        .filter(m => !m.isCompressed)
        .map(m => ({
          role: m.role === 'user' ? 'user' as const : 'sam' as const,
          text: m.content,
          timestamp: m.createdAt,
        }));
      this.push();
    } catch {
      // DB not ready, keep empty
    }
  }

  private buildPipelineContext(): string {
    const activePhases = PHASE_ORDER
      .map((p) => this.phases.get(p)!)
      .filter((e) => e.status !== 'pending')
      .map((e) => `- ${e.label}: ${e.status}${e.headline ? ' — ' + e.headline : ''}`)
      .join('\n');
    return `Pipeline for WI#${this.workItemId}: "${this.title}"\nOverall status: ${this.sessionStatus}\n\nPhases:\n${activePhases}`;
  }

  // ── VSCode actions (triggered by Sam) ───────────────────────────────────────

  private executeVsAction(action: VsAction): void {
    switch (action) {
      case 'openInVscode':
        if (this.worktreePath && fs.existsSync(this.worktreePath)) {
          vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(this.worktreePath),
            { forceNewWindow: true },
          );
        } else {
          this.addSamMessage('The worktree is not ready yet — development must complete first.');
          this.push();
        }
        break;
      case 'reviewCode':
        this.openCodeReview();
        break;
      case 'openPr':
        if (this.prUrl) {
          vscode.env.openExternal(vscode.Uri.parse(this.prUrl));
        } else {
          this.addSamMessage('No PR has been created yet.');
          this.push();
        }
        break;
    }
  }

  // ── Code review ───────────────────────────────────────────────────────────────

  private async openCodeReview(): Promise<void> {
    if (!this.worktreePath || !fs.existsSync(this.worktreePath)) {
      vscode.window.showWarningMessage('Worktree is not ready yet.');
      return;
    }
    let files: string[];
    try {
      files = getChangedFilesVsBranch(this.worktreePath, this.baseBranch);
    } catch {
      vscode.window.showWarningMessage('Could not read changed files from git.');
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage('No changed files found vs base branch.');
      return;
    }
    const tmpDir = os.tmpdir();
    let opened = 0;
    for (const rel of files) {
      const abs = path.join(this.worktreePath, rel);
      if (!fs.existsSync(abs)) continue;
      try {
        const baseContent = getFileContentAtRef(this.worktreePath, rel, this.baseBranch);
        const safe = path.basename(rel).replace(/[^a-zA-Z0-9._-]/g, '_');
        const tmp = path.join(tmpDir, `mwb-${opened}-${safe}`);
        fs.writeFileSync(tmp, baseContent, 'utf-8');
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(tmp),
          vscode.Uri.file(abs),
          `${path.basename(rel)}  (${this.baseBranch} ↔ branch)`,
          { preview: false },
        );
        opened++;
      } catch { /* skip */ }
    }
    if (opened === 0) {
      vscode.window.showWarningMessage(`No diff views could be opened.`);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  private getState(): PanelState {
    // If blueprint is known, show only the blueprint's stages; otherwise show all non-pending
    const orderedIds = this.pendingBlueprint
      ? this.pendingBlueprint.stages.map((s) => s.id)
      : PHASE_ORDER;

    const phases = orderedIds
      .map((p) => this.phases.get(p) ?? {
        phase: p,
        label: PHASE_LABELS[p] ?? p,
        agentPersona: PHASE_AGENT[p] ?? '',
        status: 'pending',
        tasks: [],
      })
      .filter((e) => {
        if (e.phase === 'init') return false;
        if (e.phase === 'revision' && e.status === 'pending') return false;
        return true;
      });
    return {
      workItemId: this.workItemId,
      title: this.title,
      sessionStatus: this.sessionStatus,
      phases,
      chat: this.chatHistory,
      devComplete: this.devComplete,
      worktreePath: this.worktreePath,
      baseBranch: this.baseBranch,
      prUrl: this.prUrl,
      pendingPhase: this.pendingPhase,
      samThinking: this.samThinking,
    };
  }

  private push(): void {
    if (!this.htmlInitialized) {
      this.panel.webview.html = this.buildHtml();
      this.htmlInitialized = true;
    }
    this.panel.webview.postMessage({ type: 'update', state: this.getState() });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100%}

/* Layout: left timeline | right chat */
.layout{display:flex;flex:1;overflow:hidden;gap:0}
.pane-timeline{width:42%;min-width:200px;overflow-y:auto;padding:14px 12px;border-right:1px solid var(--vscode-panel-border)}
.pane-chat{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* Header */
.header{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;flex-shrink:0}
.header h2{font-size:1em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.badge{font-size:.72em;padding:2px 8px;border-radius:10px;font-weight:700;text-transform:uppercase;flex-shrink:0}
.badge.active{background:var(--vscode-statusBarItem-prominentBackground,#0078d4);color:#fff}
.badge.complete{background:var(--vscode-charts-green,#4caf50);color:#000}
.badge.failed{background:var(--vscode-charts-red,#f44336);color:#fff}
.badge.paused{background:var(--vscode-charts-yellow,#ff9800);color:#000}

/* Timeline */
.tl-title{font-size:.75em;font-weight:700;opacity:.45;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.phase{display:flex;gap:10px;margin-bottom:0}
.phase-left{display:flex;flex-direction:column;align-items:center;width:20px;flex-shrink:0}
.dot{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.dot.pending{background:var(--vscode-editor-inactiveSelectionBackground);opacity:.3}
.dot.running{background:var(--vscode-charts-blue,#2196f3);color:#fff;animation:spin 1.5s linear infinite}
.dot.awaiting{background:var(--vscode-charts-yellow,#ff9800);color:#000}
.dot.complete{background:var(--vscode-charts-green,#4caf50);color:#000}
.dot.failed{background:var(--vscode-charts-red,#f44336);color:#fff}
.dot.blocked{background:var(--vscode-charts-orange,#ff5722);color:#fff}
@keyframes spin{0%{box-shadow:0 0 0 0 rgba(33,150,243,.5)}70%{box-shadow:0 0 0 6px rgba(33,150,243,0)}100%{box-shadow:0 0 0 0 rgba(33,150,243,0)}}
.connector{width:2px;flex:1;min-height:8px;background:var(--vscode-panel-border);margin:1px 0}
.connector.done{background:var(--vscode-charts-green,#4caf50);opacity:.35}
.phase-body{flex:1;padding:1px 0 14px}
.phase-header{display:flex;align-items:baseline;gap:6px}
.phase-label{font-size:.88em;font-weight:600}
.phase.pending .phase-label{opacity:.3}
.agent{font-size:.76em;opacity:.45}
.dur{font-size:.72em;opacity:.35;margin-left:auto}
.headline{margin-top:2px;font-size:.8em;opacity:.75}
.details{margin-top:3px;padding-left:2px}
.details li{font-size:.76em;opacity:.65;list-style:none;padding:1px 0}
.tasks{margin-top:4px}
.task{display:flex;align-items:center;gap:6px;font-size:.78em;padding:1px 0}
.ti{width:12px;text-align:center;font-size:9px;flex-shrink:0}
.task.running .ti{color:var(--vscode-charts-blue,#2196f3)}
.task.done .ti{color:var(--vscode-charts-green,#4caf50)}
.task.failed .ti{color:var(--vscode-charts-red,#f44336)}
.task.pending .ti{opacity:.35}
.blocked-btn{margin-top:6px}

/* Chat */
.chat-header{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:.78em;font-weight:700;opacity:.6;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px;flex-shrink:0}
.thinking-dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-charts-blue,#2196f3);animation:blink .8s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.2}50%{opacity:1}}
.chat-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:7px 11px;border-radius:6px;font-size:.84em;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:6px 6px 2px 6px}
.msg.sam{align-self:flex-start;background:var(--vscode-editor-selectionBackground);border-radius:6px 6px 6px 2px}
.msg-who{font-size:.74em;font-weight:700;opacity:.55;margin-bottom:3px}
.chat-input-row{display:flex;border-top:1px solid var(--vscode-panel-border);padding:8px;gap:7px;flex-shrink:0}
.chat-input-row input{flex:1;padding:7px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:4px;font-size:.85em;font-family:var(--vscode-font-family);outline:none}
.chat-input-row input:focus{border-color:var(--vscode-focusBorder,#007fd4)}

/* Action bar */
.actions{display:flex;gap:7px;padding:8px 12px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap}
button{padding:4px 11px;border:none;border-radius:3px;cursor:pointer;font-size:.82em;font-family:var(--vscode-font-family)}
button:hover{opacity:.8}
.b-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.b-2nd{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.b-warn{background:var(--vscode-inputValidation-warningBackground,#5a3a00);color:var(--vscode-inputValidation-warningForeground,#ffa500)}
</style>
</head>
<body>
<div class="header">
  <h2 id="title"></h2>
  <span class="badge" id="badge"></span>
</div>
<div class="layout">
  <!-- Left: phase timeline -->
  <div class="pane-timeline">
    <div class="tl-title">Pipeline</div>
    <div id="timeline"></div>
  </div>
  <!-- Right: Sam chat -->
  <div class="pane-chat">
    <div class="chat-header">
      <span>Sam · Engineering Manager</span>
      <span id="thinking" style="display:none"><span class="thinking-dot"></span></span>
    </div>
    <div class="chat-msgs" id="chatMsgs"></div>
    <div class="actions" id="actions"></div>
    <div class="chat-input-row">
      <input id="chatInput" type="text" placeholder="Message Sam…" onkeydown="if(event.key==='Enter')send()">
      <button class="b-ok" onclick="send()">Send</button>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const dotIcons = { pending:'○', running:'●', awaiting:'⏸', complete:'✔', failed:'✖', blocked:'⚠' };
const taskIcons = { pending:'○', running:'●', done:'✔', failed:'✖' };

window.addEventListener('message', e => { if (e.data.type === 'update') render(e.data.state); });

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function dur(e){
  if(!e.startedAt) return '';
  const s=Math.round(((e.completedAt||Date.now())-e.startedAt)/1000);
  return s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s';
}

function renderPhase(entry, isLast){
  const d=dur(entry);
  const tasks = entry.tasks?.length
    ? '<div class="tasks">'+entry.tasks.map(t=>
        '<div class="task '+t.status+'"><span class="ti">'+(taskIcons[t.status]||'○')+'</span><span>'+esc(t.message)+'</span></div>'
      ).join('')+'</div>' : '';
  const details = (entry.details?.length && entry.status!=='pending')
    ? '<ul class="details">'+entry.details.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>' : '';
  const headline = entry.headline ? '<div class="headline">'+esc(entry.headline)+'</div>' : '';
  const blockedBtn = entry.status==='blocked'
    ? '<div class="blocked-btn"><button class="b-warn" onclick="proceedAnyway()">▶ Proceed Anyway</button></div>' : '';
  const label = entry.status==='pending'
    ? '<span class="phase-label" style="opacity:.3">'+esc(entry.label)+'</span>'
    : '<span class="phase-label">'+esc(entry.label)+'</span>';
  const connCls = entry.status==='complete'?'done':'';
  return '<div class="phase '+entry.status+'">'
    +'<div class="phase-left"><div class="dot '+entry.status+'">'+(dotIcons[entry.status]||'○')+'</div>'
    +(isLast?'':'<div class="connector '+connCls+'"></div>')+'</div>'
    +'<div class="phase-body"><div class="phase-header">'+label
    +(entry.agentPersona?'<span class="agent">'+esc(entry.agentPersona)+'</span>':'')
    +'<span class="dur">'+esc(d)+'</span></div>'
    +headline+details+tasks+blockedBtn+'</div></div>';
}

function renderChat(msgs){
  return msgs.map(m=>{
    if(m.role==='user') return '<div class="msg user">'+esc(m.text)+'</div>';
    return '<div class="msg sam"><div class="msg-who">Sam</div>'+esc(m.text)+'</div>';
  }).join('');
}

function render(state){
  document.getElementById('title').textContent = 'WI#'+state.workItemId+': '+state.title;
  const badge=document.getElementById('badge');
  badge.textContent=state.sessionStatus; badge.className='badge '+state.sessionStatus;

  const phases=state.phases||[];
  document.getElementById('timeline').innerHTML=phases.map((p,i)=>renderPhase(p,i===phases.length-1)).join('');

  document.getElementById('chatMsgs').innerHTML=renderChat(state.chat||[]);

  document.getElementById('thinking').style.display = state.samThinking ? 'inline-flex' : 'none';

  // Actions
  let acts='';
  if(state.devComplete && state.worktreePath){
    acts+='<button class="b-ok" onclick="reviewCode()">⎋ Review Code</button>';
    acts+='<button class="b-2nd" onclick="openInVscode()">⧉ Open Worktree</button>';
  }
  if(state.prUrl){
    acts+='<button class="b-2nd" onclick="openUrl('+JSON.stringify(state.prUrl)+')">↗ Open PR</button>';
  }
  document.getElementById('actions').innerHTML=acts;

  // Scroll chat
  const cm=document.getElementById('chatMsgs');
  cm.scrollTop=cm.scrollHeight;
}

function send(){
  const input=document.getElementById('chatInput');
  const text=input.value.trim();
  if(!text) return;
  input.value='';
  vscode.postMessage({command:'chat', text});
}
function proceedAnyway(){ vscode.postMessage({command:'proceedAnyway'}); }
function reviewCode(){ vscode.postMessage({command:'reviewCode'}); }
function openInVscode(){ vscode.postMessage({command:'openInVscode'}); }
function openUrl(url){ vscode.postMessage({command:'openUrl', url}); }

render({workItemId:0,title:'Loading…',sessionStatus:'active',phases:[],chat:[],devComplete:false,worktreePath:'',baseBranch:'main',prUrl:'',samThinking:false});
</script>
</body>
</html>`;
  }
}
