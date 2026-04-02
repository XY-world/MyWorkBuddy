import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

// ══════════════════════════════════════════════════════════════════════════════
// Session — 1:1 对应 Work Item，长期存在直到 WI 完成或被 reassign
// ══════════════════════════════════════════════════════════════════════════════

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workItemId: integer('work_item_id').notNull().unique(),
  adoOrg: text('ado_org').notNull(),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull().default(''),           // 这个 session 的专属分支
  worktreePath: text('worktree_path'),                    // git worktree 路径
  title: text('title').notNull().default(''),
  status: text('status').notNull().default('active'),     // active | closed
  closedReason: text('closed_reason'),                    // resolved | reassigned | manual
  contextSummary: text('context_summary'),                // 压缩后的上下文摘要
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  closedAt: integer('closed_at'),
});

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline Run — 一个 Session 可以有多个 Run，串行执行
// ══════════════════════════════════════════════════════════════════════════════

export const pipelineRuns = sqliteTable('pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  type: text('type').notNull(),                           // Sam 命名，如 "implement_feature", "pr_fix"
  blueprintJson: text('blueprint_json'),                  // 完整的 PipelineBlueprint JSON
  phase: text('phase').notNull().default('pending'),      // pending | wi_review | planning | development | review | pr_creation | pr_monitoring | complete
  status: text('status').notNull().default('queued'),     // queued | running | complete | failed | paused
  triggeredBy: text('triggered_by').notNull(),            // user | pr_comment | wi_change | scheduled
  prId: integer('pr_id'),
  prUrl: text('pr_url'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
});

// ══════════════════════════════════════════════════════════════════════════════
// Tasks — 属于 Pipeline Run
// ══════════════════════════════════════════════════════════════════════════════

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineRunId: integer('pipeline_run_id').notNull(),
  seq: integer('seq').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  agent: text('agent').notNull(),                         // pm | dev | review | wi_review | pr_fix | investigation
  status: text('status').notNull().default('pending'),    // pending | running | done | failed | skipped
  resultSummary: text('result_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// Chat Messages — 属于 Session（跨 Pipeline Run 保留）
// ══════════════════════════════════════════════════════════════════════════════

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  role: text('role').notNull(),                           // user | sam
  content: text('content').notNull(),
  isCompressed: integer('is_compressed').notNull().default(0),  // 0 | 1，是否已压缩进 contextSummary
  pipelineRunId: integer('pipeline_run_id'),              // 可选：这条消息关联哪个 run
  createdAt: integer('created_at').notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent Messages — Agent 内部对话（短期，per Pipeline Run）
// ══════════════════════════════════════════════════════════════════════════════

export const agentMessages = sqliteTable('agent_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineRunId: integer('pipeline_run_id').notNull(),
  agentName: text('agent_name').notNull(),
  role: text('role').notNull(),                           // system | user | assistant | tool_result
  content: text('content').notNull(),
  toolCallJson: text('tool_call_json'),
  seq: integer('seq').notNull(),
  createdAt: integer('created_at').notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// Audit Log — 全程审计日志
// ══════════════════════════════════════════════════════════════════════════════

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  pipelineRunId: integer('pipeline_run_id'),
  timestamp: integer('timestamp').notNull(),
  phase: text('phase').notNull(),
  agent: text('agent').notNull(),
  eventType: text('event_type').notNull(),                // info | tool_call | decision | error | state_change
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
});

// ══════════════════════════════════════════════════════════════════════════════
// Code Changes — 文件变更记录
// ══════════════════════════════════════════════════════════════════════════════

export const codeChanges = sqliteTable('code_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineRunId: integer('pipeline_run_id').notNull(),
  taskId: integer('task_id').notNull(),
  filePath: text('file_path').notNull(),
  beforeHash: text('before_hash'),
  afterHash: text('after_hash'),
  diffPatch: text('diff_patch'),
  createdAt: integer('created_at').notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// PR Records — PR 创建记录
// ══════════════════════════════════════════════════════════════════════════════

export const prRecords = sqliteTable('pr_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  pipelineRunId: integer('pipeline_run_id').notNull(),
  prId: integer('pr_id'),
  prUrl: text('pr_url'),
  prTitle: text('pr_title'),
  targetBranch: text('target_branch'),
  status: text('status').notNull().default('draft'),      // draft | open | merged | abandoned
  createdAt: integer('created_at').notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// PR Comments — PR 评论处理状态
// ══════════════════════════════════════════════════════════════════════════════

export const prComments = sqliteTable('pr_comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  pipelineRunId: integer('pipeline_run_id'),
  prId: integer('pr_id').notNull(),
  threadId: integer('thread_id').notNull(),
  commentId: integer('comment_id').notNull(),
  content: text('content').notNull(),
  author: text('author').notNull(),
  status: text('status').notNull().default('pending'),    // pending | fixed | ignored
  fixCommit: text('fix_commit'),
  createdAt: integer('created_at').notNull(),
  processedAt: integer('processed_at'),
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent Memory — 跨 Session 长期记忆
// ══════════════════════════════════════════════════════════════════════════════

export const agentMemory = sqliteTable('agent_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentName: text('agent_name').notNull(),
  repoKey: text('repo_key').notNull(),                    // "{orgUrl}/{project}/{repo}"
  memoryType: text('memory_type').notNull(),              // code_pattern | team_preference | lesson_learned | standard
  key: text('key').notNull(),
  value: text('value').notNull(),
  confidence: real('confidence').notNull().default(1.0),
  sourceSessionId: integer('source_session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  usageCount: integer('usage_count').notNull().default(0),
});
