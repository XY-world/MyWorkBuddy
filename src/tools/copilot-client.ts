/**
 * Copilot client — dual-mode:
 *
 * Extension mode: Uses VSCode Language Model API (vscode.lm).
 *   - No subprocess, no gh CLI required.
 *   - Uses the user's existing Copilot subscription in VSCode directly.
 *   - Activated by calling setVscodeLm() during extension activation.
 *
 * CLI mode: Uses @github/copilot-sdk (spawns gh copilot subprocess).
 *   - Used when running as a standalone CLI tool.
 */

// ── VSCode LM backend (set by extension at activation) ───────────────────────

type VscodeLm = {
  selectChatModels(selector: { vendor: string; family: string }): Thenable<VscodeLmModel[]>;
  /** VSCode 1.90+ — exposes MCP tools registered by Copilot extensions */
  tools?: VscodeLmTool[];
};

type VscodeLmTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  invoke(options: { input: Record<string, unknown> }, token: any): Thenable<{ content: Array<{ value: string }> }>;
};

type VscodeLmModel = {
  sendRequest(
    messages: VscodeLmMessage[],
    options: object,
    token?: object,
  ): Thenable<{ text: AsyncIterable<string> }>;
};

type VscodeLmMessage = {
  role: 1 | 2; // 1=User, 2=Assistant
  content: Array<{ value: string }> | string;
};

// Injected by the extension — null when running in CLI mode
let _vscodeLm: VscodeLm | null = null;
let _makeMessage: ((role: 'user' | 'system', content: string) => VscodeLmMessage) | null = null;

/**
 * Called once during VSCode extension activation to wire in the LM API.
 * Passing null reverts to CLI mode (used in tests).
 */
export function setVscodeLm(
  lm: VscodeLm,
  makeUserMessage: (content: string) => VscodeLmMessage,
  makeSystemMessage: (content: string) => VscodeLmMessage,
): void {
  _vscodeLm = lm;
  _makeMessage = (role, content) =>
    role === 'user' ? makeUserMessage(content) : makeSystemMessage(content);
}

/**
 * Returns ToolDefinitions for all MCP tools registered in GitHub Copilot (vscode.lm.tools).
 * These are tools from MCP servers the user has configured in VS Code / GitHub Copilot settings.
 * Returns empty array if not in extension mode or no tools available.
 */
export function getCopilotMcpTools(): ToolDefinition[] {
  if (!_vscodeLm?.tools) return [];
  return (_vscodeLm.tools).map((t): ToolDefinition => ({
    name: `mcp_${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    description: `[Copilot MCP] ${t.description}`,
    parameters: {
      type: 'object',
      properties: t.inputSchema?.properties ?? {},
      required: (t.inputSchema as any)?.required ?? [],
    },
    handler: async (args) => {
      const result = await t.invoke({ input: args }, undefined);
      return { output: result.content.map((c) => c.value).join('\n') };
    },
  }));
}

// ── Shared session interface ──────────────────────────────────────────────────

export interface CopilotSession {
  sendAndWait(opts: { prompt: string; tools?: ToolDefinition[] }): Promise<{ text: string }>;
  close(): Promise<void>;
}

export async function createCopilotSession(systemPrompt: string): Promise<CopilotSession> {
  if (_vscodeLm) {
    return createVscodeLmSession(systemPrompt);
  }
  return createCliSession(systemPrompt);
}

// ── VSCode LM session ─────────────────────────────────────────────────────────

async function createVscodeLmSession(systemPrompt: string): Promise<CopilotSession> {
  const lm = _vscodeLm!;

  // Prefer GPT-4o; fall back to any available Copilot model
  let models = await lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
  if (!models.length) {
    models = await lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet' });
  }
  if (!models.length) {
    throw new Error(
      'No GitHub Copilot language model available. ' +
      'Make sure the GitHub Copilot extension is installed and you are signed in.',
    );
  }

  const model = models[0];
  const makeMsg = _makeMessage!;

  return {
    async sendAndWait({ prompt }) {
      const messages: VscodeLmMessage[] = [
        makeMsg('system', systemPrompt),
        makeMsg('user', prompt),
      ];

      const response = await model.sendRequest(messages, {});
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
      }
      return { text };
    },
    async close() { /* no-op for LM API */ },
  };
}

// ── CLI session (@github/copilot-sdk) ─────────────────────────────────────────

let _CopilotClient: any = null;
let _cliClient: any = null;

async function loadSdk() {
  if (!_CopilotClient) {
    try {
      const sdk = await import('@github/copilot-sdk');
      _CopilotClient = sdk.CopilotClient;
    } catch {
      throw new Error(
        'GitHub Copilot SDK not available.\n' +
        'Install: gh extension install github/gh-copilot\n' +
        'Authenticate: gh auth login',
      );
    }
  }
  return _CopilotClient;
}

async function createCliSession(systemPrompt: string): Promise<CopilotSession> {
  if (!_cliClient) {
    const CopilotClient = await loadSdk();
    _cliClient = new CopilotClient();
    await _cliClient.start();
  }
  const session = await _cliClient.createSession({ systemPrompt });
  return {
    async sendAndWait(opts) {
      const response = await session.sendAndWait(opts);
      return { text: response.text };
    },
    async close() {
      await session.close();
    },
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toToolSchemas(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.getAll().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler(args);
  }
}
