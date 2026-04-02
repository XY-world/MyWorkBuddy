import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppConfig, DEFAULT_CONFIG } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.myworkbuddy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function resolvePaths(value: string): string {
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): AppConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...JSON.parse(raw) };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  save(): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value;
  }

  getAll(): AppConfig {
    return this.config;
  }

  update(partial: Partial<AppConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Resolved work directory — ~ expanded */
  getWorkDir(): string {
    return resolvePaths(this.config.agent.workDir);
  }

  isConfigured(): boolean {
    return !!(
      this.config.ado.orgUrl &&
      this.config.ado.wiProject &&
      this.config.ado.codeProject &&
      this.config.ado.defaultRepo
    );
  }
}

let _instance: ConfigManager | null = null;

export function getConfig(): ConfigManager {
  if (!_instance) {
    _instance = new ConfigManager();
  }
  return _instance;
}

export { CONFIG_DIR, CONFIG_PATH };
