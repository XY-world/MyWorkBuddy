import * as fs from 'fs';
import * as path from 'path';
import { AgentSkillSettings, AgentSettings, Skill, McpServerConfig, DEFAULT_AGENT_SKILL_SETTINGS } from './settings-types';
import { CONFIG_DIR } from './manager';

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

export class SettingsManager {
  private data: AgentSkillSettings;

  constructor() {
    this.data = this.load();
  }

  private load(): AgentSkillSettings {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(JSON.stringify(DEFAULT_AGENT_SKILL_SETTINGS));
    }
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      // Deep merge: keep defaults for any missing agents
      const defaults = JSON.parse(JSON.stringify(DEFAULT_AGENT_SKILL_SETTINGS));
      const merged: AgentSkillSettings = {
        agents: defaults.agents.map((def: AgentSettings) => {
          const saved = (raw.agents ?? []).find((a: AgentSettings) => a.agentKey === def.agentKey);
          return saved ? { ...def, ...saved } : def;
        }),
        skills: raw.skills ?? [],
        mcps: raw.mcps ?? defaults.mcps,
      };
      return merged;
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_AGENT_SKILL_SETTINGS));
    }
  }

  save(): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  getAll(): AgentSkillSettings { return this.data; }

  setAll(data: AgentSkillSettings): void {
    this.data = data;
    this.save();
  }

  getAgentSettings(agentKey: string): AgentSettings | undefined {
    return this.data.agents.find((a) => a.agentKey === agentKey);
  }

  setAgentSettings(s: AgentSettings): void {
    const idx = this.data.agents.findIndex((a) => a.agentKey === s.agentKey);
    if (idx >= 0) this.data.agents[idx] = s;
    else this.data.agents.push(s);
    this.save();
  }

  getSkills(): Skill[] { return this.data.skills; }

  upsertSkill(s: Skill): void {
    const idx = this.data.skills.findIndex((x) => x.id === s.id);
    if (idx >= 0) this.data.skills[idx] = s;
    else this.data.skills.push(s);
    this.save();
  }

  deleteSkill(id: string): void {
    this.data.skills = this.data.skills.filter((s) => s.id !== id);
    // Remove from all agent attachments
    for (const a of this.data.agents) {
      a.attachedSkillIds = a.attachedSkillIds.filter((sid) => sid !== id);
    }
    this.save();
  }

  getMcps(): McpServerConfig[] { return this.data.mcps; }
  getEnabledMcps(): McpServerConfig[] { return this.data.mcps.filter((m) => m.enabled); }

  upsertMcp(m: McpServerConfig): void {
    const idx = this.data.mcps.findIndex((x) => x.id === m.id);
    if (idx >= 0) this.data.mcps[idx] = m;
    else this.data.mcps.push(m);
    this.save();
  }

  deleteMcp(id: string): void {
    this.data.mcps = this.data.mcps.filter((m) => m.id !== id);
    this.save();
  }
}

let _instance: SettingsManager | null = null;
export function getSettings(): SettingsManager {
  if (!_instance) _instance = new SettingsManager();
  return _instance;
}
