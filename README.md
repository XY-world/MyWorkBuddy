# myworkbuddy

Autonomous coding agent CLI + web UI that automates your Azure DevOps workflow end-to-end.

```
myworkbuddy run 1234
```

Reads the work item → PM Agent plans tasks → Dev Agent writes code → Review Agent reviews → draft PR created → work item updated to "In Review".

---

## How it works

```
myworkbuddy run <workItemId>
        │
        ▼
Orchestrator (TypeScript state machine)
        │
        ├── PM Agent "Alex"     → analyzes WI, plans tasks, names branch + PR
        ├── Dev Agent "Morgan"  → writes code per task (tool-calling loop)
        └── Review Agent "Jordan" → reviews full diff, approves or requests changes
                │
                ▼
        Draft PR created in Azure DevOps
        Work item state → "In Review"
        Full audit trail saved to SQLite
```

Each agent has a distinct **Soul** (identity + values), **User** (stakeholder perspective), and **Memory** (short-term per session + long-term cross-session learning).

All AI is powered by **GitHub Copilot CLI** (`@github/copilot-sdk`). All Microsoft tooling.

---

## Prerequisites

```bash
# 1. GitHub CLI + Copilot extension
gh auth login
gh extension install github/gh-copilot

# 2. Azure DevOps Personal Access Token
#    Scopes needed: Work Items (Read/Write), Code (Read/Write), Pull Requests (Read/Write)
export ADO_PAT=your_pat_here
```

---

## Installation

```bash
npm install -g .          # from project root
myworkbuddy init          # interactive setup wizard
```

Or run directly:
```bash
npm run dev -- run 1234
```

---

## Quick start

```bash
# Configure once
myworkbuddy init

# Run against a work item
myworkbuddy run 1234

# Dry run (planning only, no code written)
myworkbuddy run 1234 --dry-run

# Open the web UI
myworkbuddy web
```

---

## CLI commands

| Command | Description |
|---|---|
| `myworkbuddy init` | Interactive setup wizard — configure ADO, GitHub, create DB |
| `myworkbuddy run <id>` | Run the full pipeline for a work item |
| `myworkbuddy run <id> --dry-run` | PM planning only — no code written |
| `myworkbuddy status` | Show all active sessions |
| `myworkbuddy status <id>` | Per-task status for a session |
| `myworkbuddy audit <id>` | Chronological audit trail |
| `myworkbuddy audit <id> --json` | Machine-readable audit output |
| `myworkbuddy list` | All sessions (active + historical) |
| `myworkbuddy retry <id> --from-stage <stage>` | Resume from a specific phase |
| `myworkbuddy config set <key> <value>` | Update config |
| `myworkbuddy config list` | Show current config |
| `myworkbuddy web [--port 3000]` | Start local web UI |

---

## Web UI

```bash
myworkbuddy web
# Opens http://localhost:3000
```

Four screens:

- **Sprint Board** — ADO work items per sprint in Kanban columns; one-click Run
- **Pipelines** — All sessions as horizontal stage pipelines with live progress
- **Session Detail** — Real-time task list, file changes, live agent log via SSE
- **Audit Trail** — Filterable, exportable chronological event log

---

## Configuration

Config file: `~/.myworkbuddy/config.json`

```json
{
  "ado": {
    "orgUrl": "https://dev.azure.com/myorg",
    "pat": "$ADO_PAT",
    "defaultProject": "MyProject",
    "defaultRepo": "MyRepo"
  },
  "github": {
    "token": "$GITHUB_TOKEN"
  },
  "agent": {
    "maxReviewRetries": 2,
    "devConcurrency": 1,
    "workDir": "~/.myworkbuddy/workspaces"
  },
  "keyVault": {
    "vaultUrl": ""
  }
}
```

Values prefixed `$` are resolved from environment variables at runtime. Set `keyVault.vaultUrl` to read secrets from Azure Key Vault instead of environment variables.

---

## Data

- **Database:** `~/.myworkbuddy/data.db` (SQLite, auto-migrated on startup)
- **Config:** `~/.myworkbuddy/config.json`
- **Workspaces:** `~/.myworkbuddy/workspaces/` (repo clones per session)

---

## Build

```bash
npm run build          # compile TypeScript → dist/
npm run build:web      # build React frontend → dist/web/
```

---

## Tech stack

| Layer | Package |
|---|---|
| AI runtime | `@github/copilot-sdk` — sole AI engine |
| Azure DevOps | `azure-devops-node-api` |
| Auth / Secrets | `@azure/identity`, `@azure/keyvault-secrets` |
| Database | `better-sqlite3` + `drizzle-orm` |
| CLI | `commander` + `listr2` + `chalk` |
| Web server | Node `http` (built-in) + SSE |
| Web UI | React 18 + `@fluentui/react-components` v9 |
| Language | TypeScript 5 + Node.js 20 |

---

## Design docs

See [`docs/`](docs/) for detailed design documentation:

- [01 — Overview & Tech Stack](docs/01-overview.md)
- [02 — Database Schema](docs/02-database.md)
- [03 — Agent Design](docs/03-agents.md)
- [04 — Orchestrator & State Machine](docs/04-orchestrator-flow.md)
- [05 — Web UI](docs/05-web-ui.md)
- [06 — CLI & Terminal UI](docs/06-cli-terminal-ui.md)
