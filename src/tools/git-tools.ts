import { execSync } from 'child_process';
import { ToolDefinition } from './copilot-client';

// Resolve git executable once — Extension Host on Windows may not have git in PATH
let _gitExe: string | null = null;

function resolveGit(): string {
  if (_gitExe) return _gitExe;
  const candidates =
    process.platform === 'win32'
      ? [
          'git',
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files\\Git\\bin\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        ]
      : ['git'];

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'ignore' });
      _gitExe = candidate;
      return _gitExe;
    } catch { /* try next */ }
  }
  _gitExe = 'git'; // last resort
  return _gitExe;
}

function git(cwd: string, args: string): string {
  const exe = resolveGit();
  return execSync(`"${exe}" ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

export function createBranch(repoPath: string, branchName: string): void {
  git(repoPath, `checkout -b ${branchName}`);
}

export function getCurrentBranch(repoPath: string): string {
  return git(repoPath, 'rev-parse --abbrev-ref HEAD');
}

export function getDiff(repoPath: string): string {
  return git(repoPath, 'diff HEAD');
}

export function getFullDiff(repoPath: string, baseBranch = 'main'): string {
  try {
    return git(repoPath, `diff ${baseBranch}...HEAD`);
  } catch {
    return git(repoPath, 'diff HEAD');
  }
}

export function listChangedFiles(repoPath: string): string[] {
  const output = git(repoPath, 'diff --name-only HEAD');
  return output ? output.split('\n').filter(Boolean) : [];
}

export function commitChanges(repoPath: string, message: string): void {
  git(repoPath, 'add -A');
  git(repoPath, `commit -m "${message.replace(/"/g, '\\"')}" --no-verify`);
}

/**
 * Creates a git worktree at worktreePath on a new branch branchName.
 * Each work item pipeline runs in its own isolated worktree directory.
 */
export function createWorktree(repoPath: string, worktreePath: string, branchName: string): void {
  // Try creating with new branch first; if branch already exists, reuse it
  try {
    git(repoPath, `worktree add "${worktreePath}" -b ${branchName}`);
  } catch {
    // Branch may already exist (e.g. session resume) — check out existing branch
    git(repoPath, `worktree add "${worktreePath}" ${branchName}`);
  }
}

/**
 * Removes a worktree. Call this after a pipeline completes or is stopped.
 * The branch itself is kept so the PR remains valid.
 */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    git(repoPath, `worktree remove "${worktreePath}" --force`);
  } catch {
    // Worktree may already be removed; ignore
  }
}

/**
 * Prunes stale worktree entries (after manual deletion of directories).
 */
export function pruneWorktrees(repoPath: string): void {
  git(repoPath, 'worktree prune');
}

/**
 * Stages all changes and creates a commit in the given repo/worktree path.
 */
export function stageAndCommit(repoPath: string, message: string): string {
  git(repoPath, 'add -A');
  git(repoPath, `commit -m "${message.replace(/"/g, '\\"')}" --no-verify`);
  return git(repoPath, 'rev-parse HEAD');
}

/**
 * Pushes the current branch to the remote (origin).
 * Used by agents to push code changes so VSCode git UI and CodeBlend can track them.
 */
export function pushBranch(repoPath: string, branchName: string): void {
  // If branchName is empty fall back to HEAD so we never accidentally push the wrong branch
  const ref = branchName?.trim() || 'HEAD';
  git(repoPath, `push origin ${ref} --set-upstream --no-verify`);
}

/**
 * Returns the short hash of the latest commit in the given repo/worktree.
 */
export function getLatestCommitHash(repoPath: string): string {
  return git(repoPath, 'rev-parse --short HEAD');
}

/**
 * Returns true if there are uncommitted changes in the working tree.
 */
export function hasUncommittedChanges(repoPath: string): boolean {
  const status = git(repoPath, 'status --porcelain');
  return status.length > 0;
}

/**
 * Returns files changed between baseBranch and HEAD (what the AI wrote on this branch).
 */
export function getChangedFilesVsBranch(repoPath: string, baseBranch = 'main'): string[] {
  try {
    const out = git(repoPath, `diff --name-only ${baseBranch}...HEAD`);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return listChangedFiles(repoPath);
  }
}

/**
 * Returns the content of a file at a given git ref (branch/commit).
 * Returns empty string if the file didn't exist at that ref (new file).
 */
export function getFileContentAtRef(repoPath: string, relPath: string, ref: string): string {
  try {
    return git(repoPath, `show ${ref}:"${relPath.replace(/\\/g, '/')}"`);
  } catch {
    return '';
  }
}

export function buildGitTools(repoPath: string): ToolDefinition[] {
  return [
    {
      name: 'get_diff',
      description: 'Get the current git diff of all uncommitted changes in the repository',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        return { diff: getDiff(repoPath) };
      },
    },
    {
      name: 'list_changed_files',
      description: 'List all files changed since the branch was created',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        return { files: listChangedFiles(repoPath) };
      },
    },
  ];
}
