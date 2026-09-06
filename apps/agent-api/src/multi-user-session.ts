export type SessionMemberRole = "owner" | "admin" | "member" | "viewer";
export type UserPresenceStatus = "online" | "idle" | "typing" | "offline";

export interface SessionUser {
  userId: string;
  displayName: string;
  email?: string;
  role: SessionMemberRole;
  presence: UserPresenceStatus;
  lastActiveAt: string;
}

export interface MultiUserSessionState {
  sessionId: string;
  companyId: string;
  tenantId: string;
  members: Map<string, SessionUser>;
  activeTypers: Set<string>;
}

export class MultiUserSessionManager {
  private readonly sessions = new Map<string, MultiUserSessionState>();

  /**
   * Get or initialize session state
   */
  getOrCreateSession(sessionId: string, companyId: string, tenantId: string): MultiUserSessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        companyId,
        tenantId,
        members: new Map(),
        activeTypers: new Set(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Join or update user in a session
   */
  joinSession(
    sessionId: string,
    companyId: string,
    tenantId: string,
    user: { userId: string; displayName: string; email?: string; role?: SessionMemberRole }
  ): SessionUser {
    const session = this.getOrCreateSession(sessionId, companyId, tenantId);
    const existing = session.members.get(user.userId);
    const member: SessionUser = {
      userId: user.userId,
      displayName: user.displayName,
      email: user.email,
      role: user.role ?? existing?.role ?? "member",
      presence: "online",
      lastActiveAt: new Date().toISOString(),
    };
    session.members.set(user.userId, member);
    return member;
  }

  /**
   * Update presence/heartbeat of a user
   */
  updatePresence(
    sessionId: string,
    userId: string,
    presence: UserPresenceStatus
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const member = session.members.get(userId);
    if (!member) return false;

    member.presence = presence;
    member.lastActiveAt = new Date().toISOString();

    if (presence === "typing") {
      session.activeTypers.add(userId);
    } else {
      session.activeTypers.delete(userId);
    }

    return true;
  }

  /**
   * Check if user has permission to perform action in session
   */
  canPerformAction(
    sessionId: string,
    userId: string,
    action: "send_message" | "attach_tool" | "manage_members"
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const member = session.members.get(userId);
    if (!member) return false;

    switch (action) {
      case "send_message":
        // Viewers cannot send messages
        return member.role !== "viewer";
      case "attach_tool":
        // Only members, admins, and owners can attach tools
        return member.role === "owner" || member.role === "admin" || member.role === "member";
      case "manage_members":
        // Only admins and owners can manage members
        return member.role === "owner" || member.role === "admin";
      default:
        return false;
    }
  }

  /**
   * List all active members and typers in session
   */
  getSessionSnapshot(sessionId: string): {
    members: SessionUser[];
    activeTypers: string[];
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Filter stale online users (idle if > 2 mins inactive)
    const now = Date.now();
    for (const member of session.members.values()) {
      const inactiveMs = now - new Date(member.lastActiveAt).getTime();
      if (inactiveMs > 120_000 && member.presence === "online") {
        member.presence = "idle";
      }
    }

    return {
      members: Array.from(session.members.values()),
      activeTypers: Array.from(session.activeTypers),
    };
  }

  /**
   * Remove a user from a session
   */
  leaveSession(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.activeTypers.delete(userId);
    const removed = session.members.delete(userId);
    if (session.members.size === 0) {
      this.sessions.delete(sessionId);
    }
    return removed;
  }
}
