/**
 * Pipeline blueprint — produced by Sam (ManagerAgent) after reading the work item.
 * Drives what the orchestrator does instead of a hardcoded phase sequence.
 */

export type StageId =
  | 'wi_review'
  | 'planning'
  | 'development'
  | 'review'
  | 'pr_creation'
  | 'pr_monitoring'
  | 'pr_fix'
  | 'investigation'
  | 'draft_comment'
  | 'post_comment';

/** Tools available to equip on a stage's agent */
export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'list_directory'
  | 'get_diff'
  | 'list_changed_files'
  | 'search_code'
  | 'read_ado_workitem'
  | 'search_ado_wiki'
  | 'run_kql'
  | 'web_fetch';

export type PipelineType = 'coding' | 'investigation' | 'comment' | 'custom';

export interface StageDefinition {
  id: StageId;
  label: string;
  agentPersona: string;
  /** Tools to equip for this stage */
  tools: ToolName[];
  /** Sam's note to the agent for this specific WI */
  guidance?: string;
}

export interface PipelineBlueprint {
  type: PipelineType;
  rationale: string;       // Sam's explanation of why this pipeline was chosen
  stages: StageDefinition[];
}

// ── Pre-defined pipeline templates ──────────────────────────────────────────

export const CODING_PIPELINE: StageDefinition[] = [
  { id: 'wi_review',   label: 'WI Review',    agentPersona: 'Riley', tools: ['read_file', 'list_directory', 'search_code'] },
  { id: 'planning',    label: 'Planning',     agentPersona: 'Alex',  tools: ['read_file', 'list_directory', 'search_code'] },
  { id: 'development', label: 'Development',  agentPersona: 'Morgan', tools: ['read_file', 'write_file', 'list_directory', 'search_code', 'get_diff'] },
  { id: 'review',      label: 'Code Review',  agentPersona: 'Jordan', tools: ['read_file', 'list_directory', 'get_diff', 'list_changed_files'] },
  { id: 'pr_creation', label: 'Creating PR',  agentPersona: 'Sam',   tools: [] },
  { id: 'pr_monitoring', label: 'Monitoring PR', agentPersona: 'Sam', tools: [] },
];

export const INVESTIGATION_PIPELINE: StageDefinition[] = [
  { id: 'wi_review',    label: 'WI Review',      agentPersona: 'Riley', tools: ['read_file', 'list_directory', 'search_ado_wiki'] },
  { id: 'investigation', label: 'Investigation',  agentPersona: 'Alex',  tools: ['read_file', 'list_directory', 'search_code', 'search_ado_wiki', 'run_kql', 'web_fetch'] },
  { id: 'draft_comment', label: 'Draft Findings', agentPersona: 'Alex',  tools: ['read_ado_workitem'] },
  { id: 'post_comment',  label: 'Post to ADO',    agentPersona: 'Sam',   tools: [] },
];

export const COMMENT_PIPELINE: StageDefinition[] = [
  { id: 'draft_comment', label: 'Draft Comment', agentPersona: 'Alex', tools: ['read_ado_workitem', 'search_ado_wiki'] },
  { id: 'post_comment',  label: 'Post to ADO',   agentPersona: 'Sam',  tools: [] },
];
