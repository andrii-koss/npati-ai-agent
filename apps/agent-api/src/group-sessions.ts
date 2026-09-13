import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface GroupParticipant {
  id: string;
  name: string;
  type: "user" | "agent";
  role?: string;
  joinedAt: string;
}

export interface GroupSessionState {
  topic?: string;
  isolatedMemory: Record<string, string>;
  activeTurnAgentId?: string;
  messageCount: number;
}

export interface CompanyGroupSession {
  id: string;
  companyId: string;
  tenantId: string;
  title: string;
  participants: GroupParticipant[];
  sessionState: GroupSessionState;
  activeTools: string[];
  isIsolated: boolean;
  createdAt: string;
  updatedAt: string;
}

export class GroupSessionManager {
  private readonly inMemorySessions = new Map<string, CompanyGroupSession>();
  private pool?: Pool;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  setPool(pool?: Pool) {
    this.pool = pool;
  }

  async createSession(params: {
    companyId: string;
    tenantId: string;
    title: string;
    participants?: GroupParticipant[];
    initialTools?: string[];
    isIsolated?: boolean;
  }): Promise<CompanyGroupSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session: CompanyGroupSession = {
      id,
      companyId: params.companyId,
      tenantId: params.tenantId,
      title: params.title,
      participants: params.participants ?? [],
      sessionState: {
        isolatedMemory: {},
        messageCount: 0,
      },
      activeTools: params.initialTools ?? [],
      isIsolated: params.isIsolated ?? true,
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_group_sessions (
          id, company_id, tenant_id, title, participants, session_state, active_tools, is_isolated, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          session.id,
          session.companyId,
          session.tenantId,
          session.title,
          JSON.stringify(session.participants),
          JSON.stringify(session.sessionState),
          JSON.stringify(session.activeTools),
          session.isIsolated,
          session.createdAt,
          session.updatedAt,
        ]
      );
      return session;
    }

    this.inMemorySessions.set(id, session);
    return session;
  }

  async getSession(sessionId: string, companyId: string, tenantId: string): Promise<CompanyGroupSession | null> {
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, company_id AS "companyId", tenant_id AS "tenantId", title, participants,
                session_state AS "sessionState", active_tools AS "activeTools", is_isolated AS "isIsolated",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_group_sessions
         WHERE id = $1 AND company_id = $2 AND tenant_id = $3`,
        [sessionId, companyId, tenantId]
      );
      if (res.rows.length === 0) return null;
      return res.rows[0];
    }

    const session = this.inMemorySessions.get(sessionId);
    if (session && session.companyId === companyId && session.tenantId === tenantId) {
      return session;
    }
    return null;
  }

  async addParticipant(
    sessionId: string,
    companyId: string,
    tenantId: string,
    participant: Omit<GroupParticipant, "joinedAt">
  ): Promise<CompanyGroupSession | null> {
    const session = await this.getSession(sessionId, companyId, tenantId);
    if (!session) return null;

    const existingIdx = session.participants.findIndex((p) => p.id === participant.id);
    const newParticipant: GroupParticipant = {
      ...participant,
      joinedAt: new Date().toISOString(),
    };

    if (existingIdx !== -1) {
      session.participants[existingIdx] = newParticipant;
    } else {
      session.participants.push(newParticipant);
    }
    session.updatedAt = new Date().toISOString();

    if (this.pool) {
      await this.pool.query(
        `UPDATE company_group_sessions
         SET participants = $1, updated_at = $2
         WHERE id = $3 AND company_id = $4 AND tenant_id = $5`,
        [JSON.stringify(session.participants), session.updatedAt, sessionId, companyId, tenantId]
      );
    }

    return session;
  }

  async updateIsolatedMemory(
    sessionId: string,
    companyId: string,
    tenantId: string,
    key: string,
    value: string
  ): Promise<boolean> {
    const session = await this.getSession(sessionId, companyId, tenantId);
    if (!session) return false;

    session.sessionState.isolatedMemory[key] = value;
    session.updatedAt = new Date().toISOString();

    if (this.pool) {
      await this.pool.query(
        `UPDATE company_group_sessions
         SET session_state = $1, updated_at = $2
         WHERE id = $3 AND company_id = $4 AND tenant_id = $5`,
        [JSON.stringify(session.sessionState), session.updatedAt, sessionId, companyId, tenantId]
      );
    }

    return true;
  }

  async listSessions(companyId: string, tenantId: string): Promise<CompanyGroupSession[]> {
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, company_id AS "companyId", tenant_id AS "tenantId", title, participants,
                session_state AS "sessionState", active_tools AS "activeTools", is_isolated AS "isIsolated",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_group_sessions
         WHERE company_id = $1 AND tenant_id = $2
         ORDER BY updated_at DESC`,
        [companyId, tenantId]
      );
      return res.rows;
    }

    return Array.from(this.inMemorySessions.values())
      .filter((s) => s.companyId === companyId && s.tenantId === tenantId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}
