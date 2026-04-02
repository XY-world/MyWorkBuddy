export interface AppConfig {
  ado: {
    orgUrl: string;
    wiProject: string;     // project containing work items
    codeProject: string;   // project containing the repo
    defaultRepo: string;
    team?: string;         // team name for iteration queries; defaults to "{wiProject} Team"
    branchPrefix?: string; // prefix for created branches, e.g. "feature/" or "users/alias/" (default: "feature/")
  };
  agent: {
    maxReviewRetries: number;
    devConcurrency: number;
    workDir: string;
  };
  keyVault: {
    vaultUrl: string;      // empty = disabled
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  ado: {
    orgUrl: '',
    wiProject: '',
    codeProject: '',
    defaultRepo: '',
  },
  agent: {
    maxReviewRetries: 2,
    devConcurrency: 1,
    workDir: '~/.myworkbuddy/workspaces',
  },
  keyVault: {
    vaultUrl: '',
  },
};
