export interface ThreadBinding {
  channel: string; // e.g. "telegram", "slack", "discord"
  threadId: string; // e.g. "chat_123_topic_456"
  sessionId: string;
  boundAt: string;
  metadata?: Record<string, unknown>;
}

export type PluginHookEvent =
  | "before_inference"
  | "after_inference"
  | "on_tool_call"
  | "on_error"
  | "on_session_start"
  | "on_session_end";

export type PluginHookHandler<T = unknown> = (context: T) => Promise<T> | T;

export interface RegisteredHook {
  pluginId: string;
  handler: PluginHookHandler<any>;
}

export type InternalSystemEvent =
  | "session:created"
  | "session:pruned"
  | "memory:written"
  | "lease:acquired"
  | "lease:released"
  | "metrics:recorded";

export class ChannelThreadDocker {
  private readonly bindings = new Map<string, ThreadBinding>();

  private makeKey(channel: string, threadId: string): string {
    return `${channel.toLowerCase()}:${threadId}`;
  }

  /**
   * 1. Channel Docking / Thread Binding: Associates external channel threads with agent sessions
   */
  bindThread(
    channel: string,
    threadId: string,
    sessionId: string,
    metadata?: Record<string, unknown>
  ): ThreadBinding {
    const key = this.makeKey(channel, threadId);
    const binding: ThreadBinding = {
      channel: channel.toLowerCase(),
      threadId,
      sessionId,
      boundAt: new Date().toISOString(),
      metadata,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  resolveSession(channel: string, threadId: string): string | undefined {
    return this.bindings.get(this.makeKey(channel, threadId))?.sessionId;
  }

  unbindThread(channel: string, threadId: string): boolean {
    return this.bindings.delete(this.makeKey(channel, threadId));
  }

  listBindings(channel?: string): ThreadBinding[] {
    const all = Array.from(this.bindings.values());
    return channel ? all.filter((b) => b.channel === channel.toLowerCase()) : all;
  }
}

export class PluginHookManager {
  private readonly hooks = new Map<PluginHookEvent, RegisteredHook[]>();

  /**
   * 2. Plugin Hooks: Intercepts and mutates agent execution lifecycle flows
   */
  registerHook<T>(
    event: PluginHookEvent,
    pluginId: string,
    handler: PluginHookHandler<T>
  ): void {
    const list = this.hooks.get(event) ?? [];
    list.push({ pluginId, handler });
    this.hooks.set(event, list);
  }

  async executeHooks<T>(event: PluginHookEvent, context: T): Promise<T> {
    const list = this.hooks.get(event) ?? [];
    let current = context;
    for (const hook of list) {
      current = await hook.handler(current);
    }
    return current;
  }

  getRegisteredCount(event?: PluginHookEvent): number {
    if (event) return this.hooks.get(event)?.length ?? 0;
    let total = 0;
    for (const l of this.hooks.values()) total += l.length;
    return total;
  }
}

export class InternalEventBus {
  private readonly listeners = new Map<
    InternalSystemEvent,
    Array<{ priority: number; handler: (payload: any) => void }>
  >();

  /**
   * 3. Internal Hooks: High-throughput internal event bus with priority dispatching
   */
  on<T>(
    event: InternalSystemEvent,
    handler: (payload: T) => void,
    priority = 0
  ): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push({ priority, handler });
    // Sort descending by priority (higher first)
    list.sort((a, b) => b.priority - a.priority);
    this.listeners.set(event, list);

    return () => {
      const updated = (this.listeners.get(event) ?? []).filter(
        (entry) => entry.handler !== handler
      );
      this.listeners.set(event, updated);
    };
  }

  emit<T>(event: InternalSystemEvent, payload: T): void {
    const list = this.listeners.get(event) ?? [];
    for (const entry of list) {
      entry.handler(payload);
    }
  }

  listenerCount(event: InternalSystemEvent): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}
