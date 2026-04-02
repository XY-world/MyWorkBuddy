import { ToolDefinition } from './copilot-client';
import { getWorkItem, addWorkItemComment } from '../ado/work-items';
import { getConfig } from '../config/manager';

/**
 * ADO-specific tools for agents that need to read/write work items and wiki.
 */
export function buildAdoTools(project: string, workItemId: number): ToolDefinition[] {
  const cfg = getConfig().getAll();

  return [
    {
      name: 'read_ado_workitem',
      description: 'Read the full details of the current Azure DevOps work item including description, acceptance criteria, comments, and linked items',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          const wi = await getWorkItem(project, workItemId);
          return {
            id: wi.id,
            title: wi.title,
            type: wi.type,
            state: wi.state,
            description: wi.description,
            acceptanceCriteria: wi.acceptanceCriteria,
            tags: wi.tags,
            storyPoints: wi.storyPoints,
            assignedTo: wi.assignedTo,
            iterationPath: wi.iterationPath,
          };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    },

    {
      name: 'search_ado_wiki',
      description: 'Search the Azure DevOps wiki for documentation relevant to a topic',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
      handler: async ({ query }) => {
        // Use az CLI to search wiki — graceful fallback if unavailable
        try {
          const { execSync } = await import('child_process');
          const orgUrl = cfg.ado.orgUrl;
          const result = execSync(
            `az devops wiki page list --org "${orgUrl}" --project "${project}" --output json 2>/dev/null`,
            { encoding: 'utf-8', timeout: 10000 },
          );
          const pages = JSON.parse(result);
          // Simple title-match search
          const q = String(query).toLowerCase();
          const matches = (pages?.value ?? [])
            .filter((p: any) => p.path?.toLowerCase().includes(q))
            .slice(0, 5)
            .map((p: any) => ({ path: p.path, url: p.remoteUrl }));
          return { results: matches, note: 'Title-match only — open pages for full content' };
        } catch {
          return { results: [], note: 'Wiki search unavailable — az CLI not configured or no access' };
        }
      },
    },

    {
      name: 'run_kql',
      description: 'Run an Azure Data Explorer (Kusto) KQL query. Returns up to 50 rows.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'ADX cluster URL, e.g. https://mycluster.kusto.windows.net' },
          database: { type: 'string', description: 'Database name' },
          query: { type: 'string', description: 'KQL query to run' },
        },
        required: ['cluster', 'database', 'query'],
      },
      handler: async ({ cluster, database, query }) => {
        try {
          const { execSync } = await import('child_process');
          const escaped = String(query).replace(/"/g, '\\"');
          const result = execSync(
            `az kusto query --cluster-name "${cluster}" --database-name "${database}" --query-text "${escaped}" --output json 2>/dev/null`,
            { encoding: 'utf-8', timeout: 30000 },
          );
          const parsed = JSON.parse(result);
          const rows = parsed?.tables?.[0]?.rows ?? parsed ?? [];
          return { rows: rows.slice(0, 50), truncated: rows.length > 50 };
        } catch (err: any) {
          return { error: `KQL failed: ${err.message}` };
        }
      },
    },

    {
      name: 'web_fetch',
      description: 'Fetch the text content of a URL (documentation, API specs, etc.)',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
      handler: async ({ url }) => {
        try {
          const res = await fetch(String(url), { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const text = await res.text();
          // Strip HTML tags crudely, limit size
          const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000);
          return { content: plain, url };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    },
  ];
}
