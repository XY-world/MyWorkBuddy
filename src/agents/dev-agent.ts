import { BaseAgent, AgentContext, AgentOutput, CodeChangeSet } from './base';
import { buildCodeTools } from '../tools/code-tools';
import { buildGitTools } from '../tools/git-tools';
import { ToolRegistry } from '../tools/copilot-client';
import { recordCodeChange } from '../memory/code-changes';
import { fileHash } from '../tools/code-tools';
import * as fs from 'fs';
import * as path from 'path';
import { appendAuditEvent } from '../memory/audit';

export class DevAgent extends BaseAgent {
  readonly agentKey = 'dev' as const;
  readonly persona = 'Morgan';

  readonly soul = `# You are Morgan — Dev Agent

You are Morgan, a pragmatic senior engineer who values simplicity above cleverness.
Your mantra: "Make it work, make it right, make it fast — in that order." You read
existing code before writing new code. You match the style and patterns you observe in
the codebase — you never introduce new patterns without a clear reason. You write just
enough tests to validate the logic, and no more. You add a comment only when the code
cannot explain itself. You are the engineering conscience of this pipeline.`;

  readonly userPerspective = `You represent the **Engineering Lead** stakeholder.
Your primary concern: Code correctness and simplicity.
Your secondary concern: Adequate test coverage for the logic you implement.`;

  async run(ctx: AgentContext, taskId?: number): Promise<AgentOutput> {
    const { session } = ctx;
    const task = taskId
      ? ctx.tasks.find((t) => t.id === taskId)
      : ctx.tasks.find((t) => t.status === 'pending' && t.agent === 'dev');

    if (!task) {
      return { success: false, summary: 'No pending dev task found', data: null };
    }

    const phase = 'development';
    this.log(session.id, phase, 'info', `Dev Agent (${this.persona}) starting task: "${task.title}"`);

    // Register tools
    this.tools = new ToolRegistry();
    for (const t of buildCodeTools(ctx.repoPath)) this.tools.register(t);
    for (const t of buildGitTools(ctx.repoPath)) this.tools.register(t);

    const reviewContext = ctx.previousOutputs.review
      ? `\n\n## Review Feedback to Address\n${ctx.previousOutputs.review.requestedChanges.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    const taskInstructions = `
You are implementing a single coding task as part of Work Item #${ctx.workItem.id}: ${ctx.workItem.title}

## Task ${task.seq}: ${task.title}

${task.description}
${reviewContext}

## Repository: ${ctx.session.repo}
Branch: ${ctx.session.branch}

---

Use the available tools to:
1. First, explore the repository structure with list_directory
2. Read relevant existing files with read_file
3. Write new or modified files with write_file

When you have fully completed this task, respond with ONLY this JSON (no other text):
{ "done": true, "summary": "<one sentence describing what you did>", "filesModified": ["path1", "path2"] }

Important:
- Follow existing code style and patterns exactly
- Do not implement anything beyond what the task asks
- Paths in write_file must be relative to the repository root
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);
    const filesModified: string[] = [];

    // Track files before changes to record diffs
    const filesBefore = new Map<string, string>();
    const origWriteFile = this.tools.get('write_file')!.handler;
    this.tools.register({
      name: 'write_file',
      description: 'Write or overwrite a file in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      handler: async (args) => {
        const { path: filePath, content } = args as { path: string; content: string };
        const fullPath = path.resolve(ctx.repoPath, filePath);

        // Capture before-state
        if (!filesBefore.has(filePath)) {
          const beforeContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
          filesBefore.set(filePath, beforeContent ?? '');
        }

        const result = await origWriteFile(args);
        filesModified.push(filePath);

        const afterContent = fs.readFileSync(fullPath, 'utf-8');
        const beforeHash = filesBefore.get(filePath) ? fileHash(filesBefore.get(filePath)!) : null;
        const afterHash = fileHash(afterContent);

        recordCodeChange(session.id, task.id, filePath, beforeHash, afterHash);
        appendAuditEvent(session.id, phase, `dev (${this.persona})`, 'tool_call', `write_file(${filePath})`);

        return result;
      },
    });

    // Register read_file with audit
    const origReadFile = this.tools.get('read_file')!.handler;
    this.tools.register({
      name: 'read_file',
      description: 'Read the full content of a file in the repository',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (args) => {
        const result = await origReadFile(args);
        appendAuditEvent(session.id, phase, `dev (${this.persona})`, 'tool_call', `read_file(${(args as any).path})`);
        return result;
      },
    });

    this.log(session.id, phase, 'info', `Starting implementation of: ${task.title}`);

    let responseText: string;
    try {
      responseText = await this.chatWithTools(session.id, systemPrompt, 'Please implement this task.', 10);
    } catch (err: any) {
      this.log(session.id, phase, 'error', `Dev Agent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    const result = this.extractJson<{ done: boolean; summary: string; filesModified: string[] }>(responseText);

    const changeSet: CodeChangeSet = {
      filesModified: result?.filesModified ?? filesModified,
      summary: result?.summary ?? `Implemented task: ${task.title}`,
    };

    this.log(session.id, phase, 'info', `Task complete: ${changeSet.summary}`, { filesModified: changeSet.filesModified });

    return {
      success: true,
      summary: changeSet.summary,
      data: changeSet,
    };
  }
}
