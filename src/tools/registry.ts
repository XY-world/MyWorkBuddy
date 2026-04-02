/**
 * Central tool registry — all available tools defined in one place.
 * Agents/stages reference tools by name; the registry provides the implementations.
 *
 * Add new tools here and reference them by name in pipeline-types.ts StageDefinition.
 */

import { ToolDefinition } from './copilot-client';
import { buildCodeTools } from './code-tools';
import { buildGitTools } from './git-tools';
import { buildAdoTools } from './ado-tools';

export type ToolName =
  // File system
  | 'read_file'
  | 'write_file'
  | 'list_directory'
  // Git
  | 'get_diff'
  | 'list_changed_files'
  // Search
  | 'search_code'
  // ADO
  | 'read_ado_workitem'
  | 'search_ado_wiki'
  // Data
  | 'run_kql'
  // Web
  | 'web_fetch';

export interface ToolMeta {
  name: ToolName;
  displayName: string;
  description: string;
  category: 'filesystem' | 'git' | 'search' | 'ado' | 'data' | 'web';
}

/** Human-readable catalog — used in settings UI to let users configure which tools each agent gets */
export const TOOL_CATALOG: ToolMeta[] = [
  { name: 'read_file',         displayName: 'Read File',          description: 'Read any file in the repository',                   category: 'filesystem' },
  { name: 'write_file',        displayName: 'Write File',         description: 'Create or overwrite files in the repository',       category: 'filesystem' },
  { name: 'list_directory',    displayName: 'List Directory',     description: 'Browse the repository directory tree',               category: 'filesystem' },
  { name: 'get_diff',          displayName: 'Get Diff',           description: 'Show uncommitted git diff',                         category: 'git' },
  { name: 'list_changed_files', displayName: 'List Changed Files', description: 'List files changed since branch creation',         category: 'git' },
  { name: 'search_code',       displayName: 'Search Code',        description: 'Full-text search across the codebase',              category: 'search' },
  { name: 'read_ado_workitem', displayName: 'Read ADO Work Item', description: 'Read the full work item details from Azure DevOps', category: 'ado' },
  { name: 'search_ado_wiki',   displayName: 'Search ADO Wiki',    description: 'Search the Azure DevOps wiki',                      category: 'ado' },
  { name: 'run_kql',           displayName: 'Run KQL Query',      description: 'Execute a Kusto Query Language query against ADX',  category: 'data' },
  { name: 'web_fetch',         displayName: 'Fetch URL',          description: 'Fetch and read content from a URL',                 category: 'web' },
];

/** Default tool sets per agent role — can be overridden via settings */
export const DEFAULT_AGENT_TOOLS: Record<string, ToolName[]> = {
  wi_review:   ['read_file', 'list_directory', 'search_code'],
  planning:    ['read_file', 'list_directory', 'search_code'],
  development: ['read_file', 'write_file', 'list_directory', 'search_code', 'get_diff'],
  review:      ['read_file', 'list_directory', 'get_diff', 'list_changed_files'],
  investigation: ['read_file', 'list_directory', 'search_code', 'search_ado_wiki', 'run_kql', 'web_fetch'],
  draft_comment: ['read_ado_workitem', 'search_ado_wiki'],
};

/**
 * Builds the concrete ToolDefinition[] for a given set of tool names.
 * Pass the repo path and ADO context so handlers have what they need.
 */
export function buildToolset(
  toolNames: ToolName[],
  opts: { repoPath: string; adoProject: string; workItemId: number },
): ToolDefinition[] {
  const all = [
    ...buildCodeTools(opts.repoPath),
    ...buildGitTools(opts.repoPath),
    ...buildAdoTools(opts.adoProject, opts.workItemId),
  ];

  const nameSet = new Set(toolNames);
  return all.filter((t) => nameSet.has(t.name as ToolName));
}
