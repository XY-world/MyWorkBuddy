import { ToolName } from '../tools/registry';

export interface AgentSettings {
  agentKey: 'pm' | 'dev' | 'review' | 'wi_review' | 'pr_fix' | 'investigation';
  soulOverride: string;
  personaOverride: string;
  userPerspectiveOverride: string;
  toolOverrides: ToolName[];
  attachedSkillIds: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  promptText: string;
  tags: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  /** 'builtin-copilot' = use VSCode Copilot MCP tools directly (no subprocess) */
  type: 'builtin-copilot' | 'process';
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface AgentSkillSettings {
  agents: AgentSettings[];
  skills: Skill[];
  mcps: McpServerConfig[];
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings[] = [
  { agentKey: 'wi_review',     soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
  { agentKey: 'pm',            soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
  { agentKey: 'dev',           soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
  { agentKey: 'review',        soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
  { agentKey: 'pr_fix',        soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
  { agentKey: 'investigation', soulOverride: '', personaOverride: '', userPerspectiveOverride: '', toolOverrides: [], attachedSkillIds: [] },
];

export const DEFAULT_AGENT_SKILL_SETTINGS: AgentSkillSettings = {
  agents: DEFAULT_AGENT_SETTINGS,
  skills: [],
  mcps: [
    {
      id: 'copilot-builtin',
      name: 'GitHub Copilot (built-in)',
      type: 'builtin-copilot',
      command: '',
      args: [],
      env: {},
      enabled: true,
    },
  ],
};
