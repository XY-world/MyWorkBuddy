# MyWorkBuddy

Autonomous AI coding agent — CLI + VSCode extension + Web UI — that automates your Azure DevOps workflow end-to-end.

```bash
myworkbuddy run 1234
```

Reads the work item → Manager Agent triages → PM Agent plans tasks → Dev Agent writes code → Review Agent reviews → Draft PR created → Work item updated to "In Review".

---

## ✨ What's New (v0.1.0)

- **Dynamic Pipeline Blueprints** — Sam (Manager Agent) analyzes each work item and builds a custom pipeline (coding, investigation, or comment-only)
- **Multi-Agent Architecture** — 7 specialized agents with distinct personas and capabilities
- **VSCode Extension** — Full IDE integration with sidebar, status bar, and real-time progress
- **Pipeline Runs** — Multiple runs per session with independent tracking
- **PR Monitoring & Auto-Fix** — Watches for PR comments and auto-fixes them
- **Investigation Pipeline** — For research/analysis work items that don't need code changes

---

## 🏗️ Architecture

```
myworkbuddy run <workItemId>
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  PipelineRunner (TypeScript event-driven orchestrator)          │
│                                                                 │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐        │
│  │   Sam   │   │  Riley  │   │  Alex   │   │ Morgan  │        │
│  │ Manager │──▶│WI Review│──▶│   PM    │──▶│   Dev   │        │
│  └─────────┘   └─────────┘   └─────────┘   └─────────┘        │
│                                    │              │            │
│                                    ▼              ▼            │
│                              ┌─────────┐   ┌─────────┐        │
│                              │ Jordan  │◀──│ PR Fix  │        │
│                              │ Review  │   │  Agent  │        │
│                              └─────────┘   └─────────┘        │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
Draft PR created in Azure DevOps
Work item state → "In Review"
Full audit trail saved to SQLite
```

### Agents

| Agent | Persona | Role |
|-------|---------|------|
| **Sam** | Manager | Triages work items, decides pipeline type, coordinates agents |
| **Riley** | WI Reviewer | Analyzes work item clarity, identifies blockers |
| **Alex** | PM / Investigator | Plans tasks, conducts research, drafts findings |
| **Morgan** | Developer | Writes code using tool-calling loop |
| **Jordan** | Reviewer | Reviews diffs, approves or requests changes |
| **PR Fix** | — | Auto-fixes PR review comments |

Each agent has a distinct **Soul** (identity + values), **User Perspective** (stakeholder view), and **Memory** (cross-session learning).

---

## 📦 Installation

### Prerequisites

```bash
# 1. GitHub CLI + Copilot extension
gh auth login
gh extension install github/gh-copilot

# 2. Azure DevOps Personal Access Token
#    Scopes: Work Items (R/W), Code (R/W), Pull Requests (R/W)
export ADO_PAT=your_pat_here
```

### Install

```bash
# From npm (when published)
npm install -g myworkbuddy

# Or from source
git clone https://github.com/XY-world/MyWorkBuddy.git
cd MyWorkBuddy
npm install
npm run build
npm link
```

### Configure

```bash
myworkbuddy init    # Interactive setup wizard
```

---

## 🚀 Quick Start

```bash
# Run against a work item
myworkbuddy run 1234

# Dry run (planning only, no code written)
myworkbuddy run 1234 --dry-run

# Check status
myworkbuddy status 1234

# View audit trail
myworkbuddy audit 1234

# Open web dashboard
myworkbuddy web
```

---

## 💻 CLI Commands

| Command | Description |
|---------|-------------|
| `myworkbuddy init` | Interactive setup wizard |
| `myworkbuddy run <id>` | Run full pipeline for a work item |
| `myworkbuddy run <id> --dry-run` | Planning only — no code changes |
| `myworkbuddy status [id]` | Show session status (all or specific) |
| `myworkbuddy list` | List all sessions |
| `myworkbuddy audit <id>` | View chronological audit trail |
| `myworkbuddy audit <id> --json` | Machine-readable audit output |
| `myworkbuddy retry <id> --from-stage <stage>` | Resume from specific phase |
| `myworkbuddy config set <key> <value>` | Update configuration |
| `myworkbuddy config list` | Show current config |
| `myworkbuddy web [--port 3000]` | Start web dashboard |

---

## 🖥️ VSCode Extension

The extension provides full IDE integration:

- **Activity Bar** — MyWorkBuddy icon with Work Items and Pipelines views
- **Work Items Panel** — Browse ADO work items, one-click to run pipeline
- **Pipeline Panel** — Real-time progress with phase indicators
- **Detail Webview** — Task list, file changes, live agent conversation
- **Status Bar** — Shows active pipeline count and current phase

### Installing the Extension

```bash
# Build and package
npm run build
npx vsce package

# Install the .vsix in VSCode
code --install-extension myworkbuddy-0.1.0.vsix
```

---

## 🌐 Web Dashboard

```bash
myworkbuddy web
# Opens http://localhost:3000
```

Four screens:

- **Sprint Board** — ADO work items in Kanban columns; one-click Run
- **Pipelines** — All sessions as horizontal stage pipelines with live progress
- **Session Detail** — Real-time task list, file changes, agent log via SSE
- **Audit Trail** — Filterable, exportable event log

---

## 🔧 Configuration

Config file: `~/.myworkbuddy/config.json`

```json
{
  "ado": {
    "orgUrl": "https://dev.azure.com/myorg",
    "wiProject": "MyProject",
    "codeProject": "MyProject",
    "defaultRepo": "MyRepo",
    "branchPrefix": "ai/"
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

Values prefixed `$` are resolved from environment variables. Set `keyVault.vaultUrl` to read secrets from Azure Key Vault.

---

## 📊 Pipeline Types

Sam (Manager Agent) analyzes each work item and selects the appropriate pipeline:

### Coding Pipeline (default)
```
WI Review → Planning → Development → Code Review → PR Creation → PR Monitoring
```

### Investigation Pipeline
For research tasks, data analysis, or questions that don't need code:
```
WI Review → Investigation → Draft Findings → Post Comment to ADO
```

### Comment Pipeline
For simple clarifications or status updates:
```
Draft Comment → Post to ADO
```

---

## 🗃️ Data Storage

| Path | Contents |
|------|----------|
| `~/.myworkbuddy/data.db` | SQLite database (auto-migrated) |
| `~/.myworkbuddy/config.json` | Configuration |
| `~/.myworkbuddy/workspaces/` | Git worktrees per session |

### Database Schema

- **sessions** — Work item sessions (1 session per WI)
- **pipeline_runs** — Individual runs within a session
- **tasks** — Planned tasks per run
- **audit_log** — Chronological events
- **agent_messages** — LLM conversation history
- **chat_messages** — User ↔ Sam conversation
- **code_changes** — File modifications tracked per run
- **agent_memory** — Cross-session learnings

---

## 🛠️ Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Build web UI
npm run build:web

# Run in development mode
npm run dev -- run 1234

# Type check
npx tsc --noEmit

# Run tests
npm test
```

---

## 📚 Tech Stack

| Layer | Technology |
|-------|------------|
| AI Runtime | `@github/copilot-sdk` (GitHub Copilot CLI) |
| Azure DevOps | `azure-devops-node-api` |
| Auth / Secrets | `@azure/identity`, `@azure/keyvault-secrets` |
| Database | `better-sqlite3` + `drizzle-orm` |
| CLI | `commander` + `listr2` + `chalk` |
| Web Server | Node.js `http` + SSE |
| Web UI | React 18 + Fluent UI v9 |
| VSCode | VS Code Extension API |
| Language | TypeScript 5, Node.js 20+ |

---

## 📖 Documentation

See [`docs/`](docs/) for detailed design docs:

- [01 — Overview & Tech Stack](docs/01-overview.md)
- [02 — Database Schema](docs/02-database.md)
- [03 — Agent Design](docs/03-agents.md)
- [04 — Pipeline Runner & State Machine](docs/04-orchestrator-flow.md)
- [05 — Web UI](docs/05-web-ui.md)
- [06 — CLI & Terminal UI](docs/06-cli-terminal-ui.md)

---

## 📝 License

MIT

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

Built with ❤️ using GitHub Copilot + Azure DevOps
