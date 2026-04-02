import { getSqlite, saveDb } from './client';

/**
 * Database migrations for MyWorkBuddy.
 * 
 * Version 2 introduces the new Session/PipelineRun model:
 * - sessions: 1:1 with Work Item, long-lived
 * - pipeline_runs: multiple runs per session
 * - chat_messages: user-Sam conversation per session
 * - tasks now belong to pipeline_runs instead of sessions
 */

const SCHEMA_V2_SQL = `
-- ════════════════════════════════════════════════════════════════════════════════
-- Sessions (1:1 with Work Item)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL UNIQUE,
  ado_org TEXT NOT NULL,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  worktree_path TEXT,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  closed_reason TEXT,
  context_summary TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  closed_at INTEGER
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Pipeline Runs (multiple per session)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  blueprint_json TEXT,
  phase TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'queued',
  triggered_by TEXT NOT NULL,
  pr_id INTEGER,
  pr_url TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Tasks (belong to pipeline runs)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tasks_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Chat Messages (user-Sam conversation per session)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  is_compressed INTEGER NOT NULL DEFAULT 0,
  pipeline_run_id INTEGER,
  created_at INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Agent Messages (internal agent conversation per run)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_messages_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_json TEXT,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Audit Log (now includes pipeline_run_id)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  pipeline_run_id INTEGER,
  timestamp INTEGER NOT NULL,
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Code Changes (now belongs to pipeline run)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_changes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  diff_patch TEXT,
  created_at INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- PR Records (now includes pipeline_run_id)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pr_records_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  pipeline_run_id INTEGER NOT NULL,
  pr_id INTEGER,
  pr_url TEXT,
  pr_title TEXT,
  target_branch TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- PR Comments (now includes pipeline_run_id)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pr_comments_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  pipeline_run_id INTEGER,
  pr_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fix_commit TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Agent Memory (unchanged, just recreate if missing)
-- ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_session_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ════════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_sessions_work_item ON sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_session ON pipeline_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_tasks_v2_run ON tasks_v2(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_run ON agent_messages_v2(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_v2_session ON audit_log_v2(session_id);
CREATE INDEX IF NOT EXISTS idx_pr_comments_v2_session ON pr_comments_v2(session_id, pr_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_repo ON agent_memory(agent_name, repo_key);
`;

// Legacy schema for backwards compatibility
const LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_item_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  ado_org TEXT NOT NULL,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'wi_review',
  pr_url TEXT,
  worktree_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT
);
`;

export function runMigrations(): void {
  const sqlite = getSqlite();
  
  // Check if we're on the new schema
  const hasNewSchema = tableExists(sqlite, 'sessions');
  
  if (hasNewSchema) {
    // Already on v2, just ensure all tables exist
    sqlite.run(SCHEMA_V2_SQL);
  } else {
    // Check if we have old data to migrate
    const hasOldData = tableExists(sqlite, 'work_item_sessions');
    
    if (hasOldData) {
      console.log('[Migrate] Migrating from v1 to v2 schema...');
      migrateV1ToV2(sqlite);
    } else {
      // Fresh install — create v2 schema directly
      sqlite.run(SCHEMA_V2_SQL);
    }
  }
  
  saveDb();
  console.log('[Migrate] Database schema up to date');
}

function tableExists(sqlite: any, tableName: string): boolean {
  const result = sqlite.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
  return result.length > 0 && result[0].values.length > 0;
}

function migrateV1ToV2(sqlite: any): void {
  // Create new tables
  sqlite.run(SCHEMA_V2_SQL);
  
  // Migrate work_item_sessions → sessions + pipeline_runs
  const oldSessions = sqlite.exec('SELECT * FROM work_item_sessions');
  if (oldSessions.length > 0 && oldSessions[0].values.length > 0) {
    const columns = oldSessions[0].columns;
    const colIdx = (name: string) => columns.indexOf(name);
    
    for (const row of oldSessions[0].values) {
      const oldId = row[colIdx('id')];
      const workItemId = row[colIdx('work_item_id')];
      const adoOrg = row[colIdx('ado_org')];
      const project = row[colIdx('project')];
      const repo = row[colIdx('repo')];
      const branch = row[colIdx('branch')] || '';
      const title = row[colIdx('title')] || '';
      const status = row[colIdx('status')] || 'active';
      const phase = row[colIdx('phase')] || 'complete';
      const prUrl = row[colIdx('pr_url')];
      const worktreePath = row[colIdx('worktree_path')];
      const createdAt = row[colIdx('created_at')];
      const updatedAt = row[colIdx('updated_at')];
      
      // Insert into sessions
      sqlite.run(`
        INSERT INTO sessions (id, work_item_id, ado_org, project, repo, branch, worktree_path, title, status, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [oldId, workItemId, adoOrg, project, repo, branch, worktreePath, title, status === 'active' ? 'active' : 'closed', createdAt, updatedAt]);
      
      // Create a pipeline_run for this old session
      const runStatus = status === 'complete' ? 'complete' : status === 'failed' ? 'failed' : 'complete';
      sqlite.run(`
        INSERT INTO pipeline_runs (session_id, type, phase, status, triggered_by, pr_url, created_at, completed_at)
        VALUES (?, 'migrated_v1', ?, ?, 'user', ?, ?, ?)
      `, [oldId, phase, runStatus, prUrl, createdAt, updatedAt]);
    }
    
    console.log(`[Migrate] Migrated ${oldSessions[0].values.length} sessions`);
  }
  
  // Get the pipeline_run_id for each old session (for task migration)
  const runMapping = new Map<number, number>();
  const runs = sqlite.exec('SELECT id, session_id FROM pipeline_runs');
  if (runs.length > 0) {
    for (const row of runs[0].values) {
      runMapping.set(row[1] as number, row[0] as number);
    }
  }
  
  // Migrate tasks → tasks_v2
  const oldTasks = sqlite.exec('SELECT * FROM tasks');
  if (oldTasks.length > 0 && oldTasks[0].values.length > 0) {
    const columns = oldTasks[0].columns;
    const colIdx = (name: string) => columns.indexOf(name);
    
    for (const row of oldTasks[0].values) {
      const sessionId = row[colIdx('session_id')] as number;
      const pipelineRunId = runMapping.get(sessionId);
      if (!pipelineRunId) continue;
      
      sqlite.run(`
        INSERT INTO tasks_v2 (pipeline_run_id, seq, title, description, agent, status, result_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pipelineRunId,
        row[colIdx('seq')],
        row[colIdx('title')],
        row[colIdx('description')],
        row[colIdx('agent')],
        row[colIdx('status')],
        row[colIdx('result_summary')],
        row[colIdx('created_at')],
        row[colIdx('updated_at')],
      ]);
    }
    console.log(`[Migrate] Migrated ${oldTasks[0].values.length} tasks`);
  }
  
  // Migrate audit_log → audit_log_v2
  const oldAudit = sqlite.exec('SELECT * FROM audit_log');
  if (oldAudit.length > 0 && oldAudit[0].values.length > 0) {
    const columns = oldAudit[0].columns;
    const colIdx = (name: string) => columns.indexOf(name);
    
    for (const row of oldAudit[0].values) {
      const sessionId = row[colIdx('session_id')] as number;
      const pipelineRunId = runMapping.get(sessionId);
      
      sqlite.run(`
        INSERT INTO audit_log_v2 (session_id, pipeline_run_id, timestamp, phase, agent, event_type, message, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        sessionId,
        pipelineRunId || null,
        row[colIdx('timestamp')],
        row[colIdx('phase')],
        row[colIdx('agent')],
        row[colIdx('event_type')],
        row[colIdx('message')],
        row[colIdx('metadata_json')],
      ]);
    }
    console.log(`[Migrate] Migrated ${oldAudit[0].values.length} audit entries`);
  }
  
  // Rename old tables as backup
  sqlite.run('ALTER TABLE work_item_sessions RENAME TO work_item_sessions_v1_backup');
  sqlite.run('ALTER TABLE tasks RENAME TO tasks_v1_backup');
  sqlite.run('ALTER TABLE audit_log RENAME TO audit_log_v1_backup');
  
  // Rename v2 tables to canonical names
  sqlite.run('ALTER TABLE tasks_v2 RENAME TO tasks');
  sqlite.run('ALTER TABLE audit_log_v2 RENAME TO audit_log');
  sqlite.run('ALTER TABLE agent_messages_v2 RENAME TO agent_messages');
  sqlite.run('ALTER TABLE code_changes_v2 RENAME TO code_changes');
  sqlite.run('ALTER TABLE pr_records_v2 RENAME TO pr_records');
  sqlite.run('ALTER TABLE pr_comments_v2 RENAME TO pr_comments');
  
  console.log('[Migrate] V1 → V2 migration complete');
}
