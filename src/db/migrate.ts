import { getSqlite, saveDb } from './client';

const CREATE_TABLES_SQL = `
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

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  task_id INTEGER,
  agent_name TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  input_json TEXT,
  output_json TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT
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

CREATE TABLE IF NOT EXISTS code_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  diff_patch TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  pr_id INTEGER,
  pr_url TEXT,
  pr_title TEXT,
  target_branch TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_json TEXT,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS pr_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_pr_comments_session ON pr_comments(session_id, pr_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_sessions_work_item ON work_item_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_memory_repo ON agent_memory(agent_name, repo_key);
`;

export function runMigrations(): void {
  const sqlite = getSqlite();
  sqlite.run(CREATE_TABLES_SQL);

  // Incremental migrations — safe to run on existing DBs
  const addColumnIfMissing = (table: string, column: string, definition: string) => {
    const result = sqlite.exec(`PRAGMA table_info(${table})`);
    const cols = (result[0]?.values ?? []).map((row: any[]) => row[1] as string);
    if (!cols.includes(column)) {
      sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  addColumnIfMissing('work_item_sessions', 'worktree_path', 'TEXT');
  saveDb();
}
