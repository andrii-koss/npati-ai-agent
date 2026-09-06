export interface NpatiConfigProfile {
  version: string;
  defaultProvider: string;
  routingStrategy: string;
  activeChannels: string[];
  storagePath: string;
  hasApiKey: boolean;
  createdAt: string;
}

export interface CursorAcpSession {
  sessionId: string;
  workspacePath: string;
  activeFile?: string;
  status: "connected" | "disconnected";
}

export interface CopilotChatContext {
  currentFile: string;
  cursorLine: number;
  repoRoot: string;
  selection?: string;
}

export interface CopilotAcpResponse {
  sessionId: string;
  completion: string;
  suggestedDiff?: string;
  citations: string[];
}

export class OmnirouteConfigureWizard {
  /**
   * 1. omniroute configure: Interactive CLI configuration generator and validator
   */
  static generateConfig(answers: {
    defaultProvider?: string;
    apiKey?: string;
    routingStrategy?: string;
    activeChannels?: string[];
    storagePath?: string;
  }): NpatiConfigProfile {
    const defaultProvider = answers.defaultProvider ?? "anthropic";
    const routingStrategy = answers.routingStrategy ?? "cost-optimized";
    const activeChannels = answers.activeChannels ?? ["web", "telegram"];
    const storagePath = answers.storagePath ?? "./data/storage";

    const profile: NpatiConfigProfile = {
      version: "3.8.50",
      defaultProvider,
      routingStrategy,
      activeChannels,
      storagePath,
      hasApiKey: !!answers.apiKey && answers.apiKey.length > 5,
      createdAt: new Date().toISOString(),
    };

    return profile;
  }

  static validateProfile(profile: NpatiConfigProfile): boolean {
    return (
      typeof profile.defaultProvider === "string" &&
      typeof profile.routingStrategy === "string" &&
      Array.isArray(profile.activeChannels) &&
      profile.activeChannels.length > 0
    );
  }
}

export class CursorAcpAdapter {
  private readonly sessions = new Map<string, CursorAcpSession>();

  /**
   * 2. Cursor via ACP: Agent Client Protocol harness for Cursor IDE
   */
  createSession(sessionId: string, workspacePath: string): CursorAcpSession {
    const session: CursorAcpSession = {
      sessionId,
      workspacePath,
      status: "connected",
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  streamCodeEdit(
    sessionId: string,
    file: string,
    instruction: string
  ): { diff: string; modifiedFile: string } {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "connected") {
      throw new Error(`Cursor ACP session ${sessionId} is not active.`);
    }

    session.activeFile = file;
    return {
      modifiedFile: file,
      diff: `--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,4 @@\n+// [Cursor ACP] ${instruction}\n`,
    };
  }

  getSession(sessionId: string): CursorAcpSession | undefined {
    return this.sessions.get(sessionId);
  }
}

export class GithubCopilotAcpAdapter {
  /**
   * 3. GitHub Copilot via ACP: Harness integrating GitHub Copilot chat and CLI
   */
  handleCopilotTurn(
    prompt: string,
    context: CopilotChatContext
  ): CopilotAcpResponse {
    const completion = `[GitHub Copilot ACP] Analyzed ${context.currentFile}:${context.cursorLine}. Suggested code for "${prompt.slice(0, 50)}"`;
    
    return {
      sessionId: `copilot_${Date.now()}`,
      completion,
      suggestedDiff: `+ // Copilot suggestion for ${context.currentFile}`,
      citations: [context.currentFile],
    };
  }
}
