import { getAdoConnection } from './client';
import {
  GitPullRequest,
  CommentThreadStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces';

export interface CreatePrOptions {
  project: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  workItemId: number;
  isDraft: boolean;
}

export interface PrResult {
  prId: number;
  prUrl: string;
}

export interface PrCommentThread {
  threadId: number;
  status: string;  // active|fixed|wontFix|closed|byDesign|pending
  comments: Array<{
    id: number;
    content: string;
    author: string;
    publishedDate: Date;
    isDeleted: boolean;
  }>;
  filePath?: string;   // present for file-level comments
  startLine?: number;
}

export async function createDraftPR(opts: CreatePrOptions): Promise<PrResult> {
  const conn = await getAdoConnection();
  const gitApi = await conn.getGitApi();

  const pr: GitPullRequest = {
    title: opts.title,
    description: opts.description,
    sourceRefName: `refs/heads/${opts.sourceBranch}`,
    targetRefName: `refs/heads/${opts.targetBranch}`,
    isDraft: opts.isDraft,
    workItemRefs: [{ id: String(opts.workItemId) }],
  };

  const created = await gitApi.createPullRequest(pr, opts.repo, opts.project);
  if (!created?.pullRequestId) throw new Error('Failed to create pull request');

  const adoOrg = conn.serverUrl.replace(/\/$/, '');
  const prUrl = `${adoOrg}/${opts.project}/_git/${opts.repo}/pullrequest/${created.pullRequestId}`;

  return { prId: created.pullRequestId, prUrl };
}

/**
 * Fetches all active comment threads on a PR, excluding system-generated threads
 * and threads marked as fixed/closed. Returns only threads that need attention.
 */
export async function getPrCommentThreads(
  project: string,
  repo: string,
  prId: number,
): Promise<PrCommentThread[]> {
  const conn = await getAdoConnection();
  const gitApi = await conn.getGitApi();

  const threads = await gitApi.getThreads(repo, prId, project);
  if (!threads) return [];

  const activeStatuses = new Set([
    CommentThreadStatus.Active,
    CommentThreadStatus.Pending,
    undefined,  // unknown/unset status treated as active
  ]);

  return threads
    .filter((t) => activeStatuses.has(t.status) && !t.isDeleted)
    .map((t) => ({
      threadId: t.id!,
      status: threadStatusLabel(t.status),
      comments: (t.comments ?? [])
        .filter((c) => !c.isDeleted && c.commentType !== 1) // 1 = system comment
        .map((c) => ({
          id: c.id!,
          content: c.content ?? '',
          author: (c.author as any)?.displayName ?? 'unknown',
          publishedDate: c.publishedDate ? new Date(c.publishedDate) : new Date(),
          isDeleted: c.isDeleted ?? false,
        })),
      filePath: (t.threadContext as any)?.filePath,
      startLine: (t.threadContext as any)?.rightFileStart?.line,
    }))
    .filter((t) => t.comments.length > 0);
}

/**
 * Replies to a specific comment thread on a PR.
 * Used by PrFixAgent to confirm a comment has been addressed.
 */
export async function replyToPrCommentThread(
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  content: string,
): Promise<void> {
  const conn = await getAdoConnection();
  const gitApi = await conn.getGitApi();
  await gitApi.createComment({ content }, repo, prId, threadId, project);
}

/**
 * Marks a comment thread as fixed.
 */
export async function resolvePrCommentThread(
  project: string,
  repo: string,
  prId: number,
  threadId: number,
): Promise<void> {
  const conn = await getAdoConnection();
  const gitApi = await conn.getGitApi();
  await gitApi.updateThread(
    { status: CommentThreadStatus.Fixed },
    repo,
    prId,
    threadId,
    project,
  );
}

/**
 * Returns the current status of a PR: draft|active|abandoned|completed
 */
export async function getPrStatus(project: string, repo: string, prId: number): Promise<string> {
  const conn = await getAdoConnection();
  const gitApi = await conn.getGitApi();
  const pr = await gitApi.getPullRequest(repo, prId, project);
  if (!pr) return 'unknown';
  if (pr.isDraft) return 'draft';
  switch (pr.status) {
    case 1: return 'active';
    case 2: return 'abandoned';
    case 3: return 'completed';
    default: return 'unknown';
  }
}

export async function linkWorkItemToPR(
  project: string,
  repo: string,
  prId: number,
  workItemId: number,
): Promise<void> {
  // Work item refs are set during PR creation; this is a no-op fallback
  void project; void repo; void prId; void workItemId;
}

function threadStatusLabel(status: CommentThreadStatus | undefined): string {
  switch (status) {
    case CommentThreadStatus.Active: return 'active';
    case CommentThreadStatus.Fixed: return 'fixed';
    case CommentThreadStatus.WontFix: return 'wontFix';
    case CommentThreadStatus.Closed: return 'closed';
    case CommentThreadStatus.ByDesign: return 'byDesign';
    case CommentThreadStatus.Pending: return 'pending';
    default: return 'active';
  }
}
