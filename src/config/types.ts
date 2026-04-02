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
    /** Maximum number of pipelines that can run concurrently (others are queued) */
    maxConcurrency: number;
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
    maxConcurrency: 2,
    workDir: '~/.myworkbuddy/workspaces',
  },
  keyVault: {
    vaultUrl: '',
  },
};
