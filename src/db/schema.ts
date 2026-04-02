import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

export const workItemSessions = sqliteTable('work_item_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workItemId: integer('work_item_id').notNull(),
  adoOrg: text('ado_org').notNull(),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull().default(''),
  title: text('title').notNull().default(''),
  status: text('status').notNull().default('active'), // active|complete|failed|paused
  phase: text('phase').notNull().default('wi_review'), // wi_review|init|planning|development|review|revision|pr_creation|pr_monitoring|pr_fix|complete
  prUrl: text('pr_url'),
  worktreePath: text('worktree_path'),               // absolute path to git worktree for this WI
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  seq: integer('seq').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  agent: text('agent').notNull(), // pm|dev|review|wi_review|pr_fix
  status: text('status').notNull().default('pending'), // pending|running|done|failed|skipped
  resultSummary: text('result_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  taskId: integer('task_id'),
  agentName: text('agent_name').notNull(),
  model: text('model'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  inputJson: text('input_json'),
  outputJson: text('output_json'),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  status: text('status').notNull().default('running'), // running|success|failed
  error: text('error'),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  timestamp: integer('timestamp').notNull(),
  phase: text('phase').notNull(),
  agent: text('agent').notNull(),
  eventType: text('event_type').notNull(), // info|tool_call|decision|error|state_change
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
});

export const codeChanges = sqliteTable('code_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  taskId: integer('task_id').notNull(),
  filePath: text('file_path').notNull(),
  beforeHash: text('before_hash'),
  afterHash: text('after_hash'),
  diffPatch: text('diff_patch'),
  createdAt: integer('created_at').notNull(),
});

export const prRecords = sqliteTable('pr_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  prId: integer('pr_id'),
  prUrl: text('pr_url'),
  prTitle: text('pr_title'),
  targetBranch: text('target_branch'),
  status: text('status').notNull().default('draft'), // draft|open|merged|abandoned
  createdAt: integer('created_at').notNull(),
});

// Tracks PR comment threads that have been seen and processed
export const prComments = sqliteTable('pr_comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  prId: integer('pr_id').notNull(),
  threadId: integer('thread_id').notNull(),
  commentId: integer('comment_id').notNull(),
  content: text('content').notNull(),
  author: text('author').notNull(),
  status: text('status').notNull().default('pending'), // pending|fixed|ignored
  fixCommit: text('fix_commit'),
  createdAt: integer('created_at').notNull(),
  processedAt: integer('processed_at'),
});

// SHORT-TERM: full conversation history per agent per session
export const agentMessages = sqliteTable('agent_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  agentName: text('agent_name').notNull(),
  role: text('role').notNull(), // system|user|assistant|tool_result
  content: text('content').notNull(),
  toolCallJson: text('tool_call_json'),
  seq: integer('seq').notNull(),
  createdAt: integer('created_at').notNull(),
});

// LONG-TERM: cross-session learnings about a repo
export const agentMemory = sqliteTable('agent_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentName: text('agent_name').notNull(),
  repoKey: text('repo_key').notNull(), // "{orgUrl}/{project}/{repo}"
  memoryType: text('memory_type').notNull(), // code_pattern|team_preference|lesson_learned|standard
  key: text('key').notNull(),
  value: text('value').notNull(),
  confidence: real('confidence').notNull().default(1.0),
  sourceSessionId: integer('source_session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  usageCount: integer('usage_count').notNull().default(0),
});
