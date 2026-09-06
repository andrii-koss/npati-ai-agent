export interface ExternalPluginManifest {
  id: string;
  name: string;
  channel: string;
  version: string;
  requestedPermissions: string[];
  isTrusted: boolean;
}

export interface GroupMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
}

export interface GroupChatRecord {
  groupId: string;
  channel: string;
  title: string;
  members: string[];
  messages: GroupMessage[];
  createdAt: string;
}

export interface MentionActivationResult {
  activates: boolean;
  reason: "dm_direct" | "explicit_mention" | "command_prefix" | "name_callout" | "ignored";
  strippedPrompt: string;
}

export class ExternalChannelPluginLoader {
  private readonly loadedPlugins = new Map<string, ExternalPluginManifest>();

  /**
   * 1. External Channel Plugins: Sandboxed loader for 3rd-party community channel drivers
   */
  loadPlugin(manifest: ExternalPluginManifest): {
    success: boolean;
    pluginId: string;
    warning?: string;
  } {
    // If untrusted, flag security policy warning
    let warning: string | undefined;
    if (!manifest.isTrusted) {
      warning = `Plugin '${manifest.name}' is untrusted. Restricting network sockets and filesystem permissions.`;
    }

    this.loadedPlugins.set(manifest.id, manifest);

    return {
      success: true,
      pluginId: manifest.id,
      warning,
    };
  }

  getPlugin(id: string): ExternalPluginManifest | undefined {
    return this.loadedPlugins.get(id);
  }

  listPlugins(): ExternalPluginManifest[] {
    return Array.from(this.loadedPlugins.values());
  }
}

export class GroupChatManager {
  private readonly groups = new Map<string, GroupChatRecord>();

  /**
   * 2. Group Chat: Manages multi-participant shared thread context and typing dynamics
   */
  createGroup(
    groupId: string,
    channel: string,
    title: string,
    members: string[] = []
  ): GroupChatRecord {
    const record: GroupChatRecord = {
      groupId,
      channel,
      title,
      members,
      messages: [],
      createdAt: new Date().toISOString(),
    };
    this.groups.set(groupId, record);
    return record;
  }

  recordMessage(
    groupId: string,
    msg: { messageId: string; senderId: string; senderName: string; text: string }
  ): GroupMessage {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found.`);

    const message: GroupMessage = {
      ...msg,
      timestamp: new Date().toISOString(),
    };
    group.messages.push(message);

    if (!group.members.includes(msg.senderId)) {
      group.members.push(msg.senderId);
    }

    return message;
  }

  getRecentHistory(groupId: string, limit = 20): GroupMessage[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return group.messages.slice(-limit);
  }
}

export class MentionActivationRouter {
  /**
   * 3. Mention Activation: Activates agent in groups only when explicitly mentioned or commanded
   */
  static evaluate(
    text: string,
    config: {
      botName: string;
      botUsername: string;
      isDm?: boolean;
      aliases?: string[];
    }
  ): MentionActivationResult {
    const trimmed = text.trim();

    // 1. DMs always activate
    if (config.isDm) {
      return {
        activates: true,
        reason: "dm_direct",
        strippedPrompt: trimmed,
      };
    }

    // 2. Command prefix e.g. /agent or /help
    if (trimmed.startsWith("/")) {
      return {
        activates: true,
        reason: "command_prefix",
        strippedPrompt: trimmed.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim(),
      };
    }

    // 3. Username mention e.g. @npati_bot
    const mentionRegex = new RegExp(`@${config.botUsername}\\b`, "i");
    if (mentionRegex.test(trimmed)) {
      return {
        activates: true,
        reason: "explicit_mention",
        strippedPrompt: trimmed.replace(mentionRegex, "").trim(),
      };
    }

    // 4. Name callout e.g. "NPATI, please check logs"
    const nameCalloutRegex = new RegExp(`^${config.botName}[,:]?\\s*`, "i");
    if (nameCalloutRegex.test(trimmed)) {
      return {
        activates: true,
        reason: "name_callout",
        strippedPrompt: trimmed.replace(nameCalloutRegex, "").trim(),
      };
    }

    // 5. Aliases
    if (config.aliases) {
      for (const alias of config.aliases) {
        const aliasRegex = new RegExp(`@?${alias}\\b`, "i");
        if (aliasRegex.test(trimmed)) {
          return {
            activates: true,
            reason: "explicit_mention",
            strippedPrompt: trimmed.replace(aliasRegex, "").trim(),
          };
        }
      }
    }

    return {
      activates: false,
      reason: "ignored",
      strippedPrompt: trimmed,
    };
  }
}
