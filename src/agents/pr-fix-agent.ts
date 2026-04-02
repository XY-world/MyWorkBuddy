import { BaseAgent, AgentContext, AgentOutput, PrFixResult } from './base';
import { buildCodeTools } from '../tools/code-tools';
import { buildGitTools } from '../tools/git-tools';
import { ToolRegistry } from '../tools/copilot-client';
import { stageAndCommit } from '../tools/git-tools';
import { recordCodeChange } from '../memory/code-changes';
import { fileHash } from '../tools/code-tools';
import { appendAuditEvent } from '../memory/audit';
import * as fs from 'fs';
import * as path from 'path';

/**
 * PrFixAgent (Persona: Morgan — same dev persona, specialized for PR fixes)
 *
 * Triggered when PR comment threads are found during pr_monitoring phase.
 * For each active comment thread:
 * 1. Reads the comment content and identifies the file/line being referenced
 * 2. Understands what change is requested
 * 3. Modifies the relevant code
 * 4. Stages and commits the fix
 *
 * The orchestrator handles replying to PR threads and resolving them after this agent runs.
 */
export class PrFixAgent extends BaseAgent {
  readonly agentKey = 'pr_fix' as const;
  readonly persona = 'Morgan';

  readonly soul = `# You are Morgan — PR Fix Agent

You are Morgan, the same pragmatic senior engineer who wrote the original code.
You are now addressing reviewer feedback on the pull request. You read each comment
carefully and make the minimal change needed to address the feedback. You do not
refactor unrelated code. You do not change things the reviewer didn't ask about.
You respond to feedback precisely and professionally. Each fix should be atomic —
one commit per logical group of comments.`;

  readonly userPerspective = `You represent the **Engineering Lead** stakeholder.
Your primary concern: Address reviewer feedback accurately and minimally.
Your secondary concern: Each fix should pass code review without introducing new issues.`;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const { session } = ctx;
    const phase = 'pr_fix';
    const threads = ctx.prCommentThreads ?? [];

    if (threads.length === 0) {
      return { success: true, summary: 'No comment threads to fix', data: { commentsFixed: 0, commitHash: '', fixSummary: 'Nothing to fix' } };
    }

    this.log(session.id, phase, 'info', `PrFixAgent (${this.persona}) addressing ${threads.length} PR comment thread(s)`);

    // Register tools
    this.tools = new ToolRegistry();
    for (const t of buildCodeTools(ctx.repoPath)) this.tools.register(t);
    for (const t of buildGitTools(ctx.repoPath)) this.tools.register(t);

    const filesModified: string[] = [];
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
        if (!filesBefore.has(filePath)) {
          const beforeContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
          filesBefore.set(filePath, beforeContent ?? '');
        }
        const result = await origWriteFile(args);
        filesModified.push(filePath);
        const afterContent = fs.readFileSync(fullPath, 'utf-8');
        const beforeHash = filesBefore.get(filePath) ? fileHash(filesBefore.get(filePath)!) : null;
        const afterHash = fileHash(afterContent);
        recordCodeChange(session.id, 0, filePath, beforeHash, afterHash);
        appendAuditEvent(session.id, phase, `pr_fix (${this.persona})`, 'tool_call', `write_file(${filePath})`);
        return result;
      },
    });

    // Format comment threads into a readable list for the agent
    const commentsList = threads.map((t, i) => {
      const fileRef = t.filePath ? `\nFile: ${t.filePath}${t.startLine ? `:${t.startLine}` : ''}` : '';
      const comments = t.comments.map((c) => `  [${c.author}]: ${c.content}`).join('\n');
      return `Thread ${i + 1} (id: ${t.threadId})${fileRef}\n${comments}`;
    }).join('\n\n');

    const taskInstructions = `
You are addressing pull request review comments for Work Item #${ctx.workItem.id}: ${ctx.workItem.title}
Branch: ${ctx.session.branch}

## Active PR Comment Threads

${commentsList}

---

Use the available tools to:
1. Read the files referenced in the comments (use read_file)
2. Make the minimal changes needed to address each comment (use write_file)
3. Do NOT modify code unrelated to the comments

When you have addressed all comments, respond with ONLY this JSON:
{
  "done": true,
  "fixSummary": "<one sentence describing all fixes made>",
  "filesModified": ["path1", "path2"],
  "threadsAddressed": [<threadId1>, <threadId2>]
}

Important:
- Address each comment precisely — do not over-engineer
- If a comment is unclear, make the most reasonable interpretation
- Do not commit the changes — the orchestrator will commit after you finish
`;

    const systemPrompt = this.buildSystemPrompt(ctx, taskInstructions);

    this.log(session.id, phase, 'info', `Addressing ${threads.length} PR comment thread(s)`);

    let responseText: string;
    try {
      responseText = await this.chatWithTools(session.id, systemPrompt, 'Please address the PR review comments.', 12);
    } catch (err: any) {
      this.log(session.id, phase, 'error', `PrFixAgent failed: ${err.message}`);
      return { success: false, summary: err.message, data: null };
    }

    const result = this.extractJson<{ done: boolean; fixSummary: string; filesModified: string[]; threadsAddressed: number[] }>(responseText);

    const commitHash = ''; // orchestrator will commit and fill this in
    const fixResult: PrFixResult = {
      commentsFixed: result?.threadsAddressed?.length ?? threads.length,
      commitHash,
      fixSummary: result?.fixSummary ?? `Addressed ${threads.length} PR comment(s)`,
    };

    this.log(session.id, phase, 'info', `PR fix complete: ${fixResult.fixSummary}`, { filesModified: result?.filesModified ?? filesModified });

    return {
      success: true,
      summary: fixResult.fixSummary,
      data: fixResult,
    };
  }
}
