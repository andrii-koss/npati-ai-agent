import { WorkspaceAccessError } from "./errors";

/**
 * C5a: company membership. Membership is the authorisation anchor of the coding agent
 * (user -> company -> project -> workspace -> session -> sandbox), so a row is the **only** source of a
 * role: no row means no role, and nothing may assume "owner by default".
 *
 * These record types are **structurally identical** to `CompanyMember` / `CompanyInvite` in
 * `apps/agent-api/src/code-membership.ts`, whose `CodeMembershipStore` port is the contract other agents
 * are written against. Field names, optionality and types must stay in sync with that port; timestamps
 * are `Date` because the port compares them with `Date#getTime()` for invite expiry. `WorkspaceStore`
 * implements the port directly, so `CodeMembershipService` needs no adapter.
 */
export type CompanyRole = "owner" | "admin" | "developer" | "reviewer";
export const COMPANY_ROLES: readonly CompanyRole[] = ["owner", "admin", "developer", "reviewer"] as const;
/** Mirrors the `company_members.status` CHECK constraint in migration 072. */
export type CompanyMemberStatus = "active" | "invited" | "suspended";
export const COMPANY_MEMBER_STATUSES: readonly CompanyMemberStatus[] = ["active", "invited", "suspended"] as const;

/** Runtime guard for data that did not come from TypeScript (a raw column, a request body). */
export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === "string" && (COMPANY_ROLES as readonly string[]).includes(value);
}

export interface CompanyMember {
  id: string;
  companyId: string;
  userId: string;
  /** The role actually recorded for this (company, user); never inferred, never defaulted. */
  role: CompanyRole;
  status: CompanyMemberStatus;
  invitedBy?: string | null;
  invitedAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic concurrency token, bumped on every accepted write. */
  revision: number;
}

export interface CompanyInvite {
  id: string;
  companyId: string;
  email: string;
  role: CompanyRole;
  /** SHA-256 of the invite token; the token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  createdBy: string;
  acceptedAt?: Date | null;
  createdAt: Date;
}

/** The port's `createCompanyInvite` argument: the caller may stamp `createdAt`, otherwise the store does. */
export type CompanyInviteInput = Omit<CompanyInvite, "createdAt"> & { createdAt?: Date };

/** The port's `acceptCompanyInvite` argument (arguments are named records so the port stays readable). */
export interface AcceptCompanyInviteInput {
  invite: CompanyInvite;
  userId: string;
  acceptedAt: Date;
}

/** The port's `updateCompanyMemberRole` argument. `expectedRevision` is mandatory: no blind writes. */
export interface UpdateCompanyMemberRoleInput {
  companyId: string;
  userId: string;
  role: CompanyRole;
  expectedRevision: number;
  updatedAt: Date;
}

/** The port's `removeCompanyMember` argument. */
export interface RemoveCompanyMemberInput {
  companyId: string;
  userId: string;
}

/**
 * Membership refusal raised by a **store** (the service raises `CodeMembershipError` instead).
 *
 * The shape mirrors `CodeMembershipError` in `apps/agent-api/src/code-membership.ts`
 * (`code`, `httpStatus`, `retryable`, `details`) so a route layer can map both through one switch, and it
 * carries the codes the port contract names: `membership_not_found` (404) and
 * `membership_revision_conflict` (409, `details: { expectedRevision, actualRevision }`) — the same values
 * `CodeMembershipService` sees from an injected store.
 *
 * It extends `WorkspaceAccessError` on purpose: the tree-wide route mappers already recognise that class
 * (and map a "changed by another request" message to 409), so the precise refusal is never reported as an
 * unexpected 500. It is used for the store-side safety refusals as well: an expired or already-used invite
 * reaching the store, the only owner being demoted or removed, a duplicate invite token hash and an
 * unknown role.
 */
export class CompanyMembershipError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CompanyMembershipError";
    this.code = code;
    // Same default as `CodeMembershipError`: a refusal denies access unless it says otherwise.
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * C5b: ProviderDataPolicy records.
 *
 * These mirror `ProviderDataPolicyRecord`, `ProjectDataPolicyRecord`, `ProviderDataPolicyVersionRecord`
 * and `ProviderHostedConsentRecord` in `apps/agent-api/src/provider-data-policy.ts` **structurally** —
 * the workspace package cannot import the app, exactly like the C5a membership port. The app-side module
 * is the contract other agents are written against, so field names, optionality and types must stay in
 * sync; `DataClassification` is reused verbatim so there is one classification vocabulary in the tree.
 *
 * Semantics the store must not soften:
 * - `companyId === null` on a policy means "platform default, applies to every company"; a non-null value
 *   means that tenant only. Tenant isolation is by `companyId`, never by the caller's convenience.
 * - `modelPattern === null` means "the whole provider"; a value scopes the policy to matching models.
 * - `policyVersion` is monotonic and must be bumped by the store, which also appends the snapshot that the
 *   version refers to. A write whose `expectedPolicyVersion` does not match is refused, never merged.
 * - A project policy with no row is `confidential` — the record type has no "unspecified" state, because
 *   the default must be a value, not an absence.
 * - A hosted-provider consent with `revokedAt !== null` counts as **no** consent.
 */
