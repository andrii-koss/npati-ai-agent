import type { AuthContext } from "@npati/workspace";
import {
  authorizeCodeAction,
  classifyPrincipal,
  requiredPermissionForAction,
  type CodeRbacDeps,
} from "./code-rbac";
import {
  FAIL_CLOSED_ALLOWED_CONTENT_TYPES,
  MANDATORY_REDACTIONS,
  ProviderDataPolicyError,
  ProviderDataPolicyService as ProviderDataPolicyStoreService,
  classifyContent,
  isPolicyStale,
  parseExternalRetention,
  policyAllowsClassification,
  policyAllowsContentType,
  policyStalenessReason,
  strictestClassification,
  validateProviderDataPolicyInput,
  type ExternalRetention,
  type ProviderContentType,
  type ProviderDataClassification,
  type ProviderDataPolicyKind,
  type ProviderDataPolicyRecord,
  type ProviderDataPolicyVersionRecord,
  type ProviderHostedConsentRecord,
  type ProviderRedactionKind,
  type ProviderTrainingPolicy,
  type ProjectDataPolicyPathRule,
  type ProjectDataPolicyRecord,
} from "./provider-data-policy";

/**
 * C5b (part 4) — the **management** layer of the provider data policy.
 *
 * `provider-data-policy.ts` owns the vocabulary, the fail-closed defaults and the audited store writes.
 * This module owns who may change what: every method authorizes through the shared C5a gate
 * (`authorizeCodeAction`) before it touches anything, records an Activity event, and exposes the
 * read models the UI needs (including *why* a model is not eligible to receive code).
 *
 * Two properties are the reason this file exists rather than putting the checks in the routes:
 *
 *  1. **Authorization is anchored on the company role.** Like the C5a membership and protected-branch
 *     surfaces, the company-scoped context drops the legacy workspace permissions, so a workspace-wide
 *     grant cannot widen a company-scoped data-policy route and a caller without a membership row is
 *     refused instead of inheriting anything.
 *  2. **Changing the policy is owner-level, through the ordinary gate.** The write surfaces require the
 *     privileged `code.policy.manage`, which `*`, `admin:all` and `owner` never imply through a wildcard;
 *     the company `owner` role names it explicitly in `DEFAULT_COMPANY_ROLE_MATRIX`, so there is exactly
 *     one authorization mechanism (the RBAC gate) rather than a special case layered on top of it.
 *
 * It also owns one data rule that belongs to neither table: the **effective** project classification is
 * the strictest of the C5b policy row and the project record's own C1 classification, so neither source
 * can quietly lower the protection the other one set.
 */

/**
 * Action names of this surface. Each is mapped in `code-rbac.ts`, so an unmapped name is refused by
 * default (`action_not_mapped`) instead of silently authorizing.
 */
export const CODE_DATA_POLICY_ACTIONS = {
  providerList: "provider.data_policy.read",
  providerUpsert: "provider.data_policy.upsert",
  providerVersions: "provider.data_policy.versions",
  projectRead: "project.data_policy.read",
  projectUpsert: "project.data_policy.upsert",
  projectLowerClassification: "project.data_policy.lower_classification",
  eligibility: "provider.data_policy.eligibility",
  hostedConsentGrant: "provider.hosted_consent.grant",
  hostedConsentRevoke: "provider.hosted_consent.revoke",
} as const;

/**
 * The actions that require the owner-level permission. Raising a classification narrows what may be sent,
 * so it is an ordinary workspace write; lowering it widens the surface, so it takes its own action name
 * and therefore the privileged permission.
 */
export const OWNER_LEVEL_DATA_POLICY_ACTIONS: readonly string[] = [
  CODE_DATA_POLICY_ACTIONS.providerUpsert,
  CODE_DATA_POLICY_ACTIONS.projectLowerClassification,
  CODE_DATA_POLICY_ACTIONS.hostedConsentGrant,
  CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke,
];

// ---------------------------------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------------------------------

/**
 * One `provider_policy_decision` per accepted change.
 *
 * `changes` carries **field names only** — never values — because a policy row is exactly the kind of
 * object that must not be copied into a log stream: it names terms, reviewers and jurisdictions, and a
 * future field could be a secret. `assertNoSensitiveProviderPolicyEvent` enforces that before the sink
 * sees anything.
 */
export interface ProviderPolicyActivityEvent {
  kind: "provider_policy_decision";
  companyId: string;
  providerId: string | null;
  projectId: string | null;
  action: string;
  actor: string;
  decision: "allow" | "deny";
  policyVersion: number | null;
  changes: string[];
  at: string;
}

export interface ProviderPolicyActivitySink {
  record(event: ProviderPolicyActivityEvent): void | Promise<void>;
}

/** Event keys that would carry policy or content values instead of field names. */
const FORBIDDEN_EVENT_KEYS = [
  "payload",
  "policy",
  "policies",
  "values",
  "content",
  "contents",
  "command",
  "diff",
  "file",
  "files",
  "secret",
  "secrets",
  "token",
  "tokens",
  "termsUrl",
] as const;

/**
 * Refuse an event that carries policy values, content or a secret anywhere in it. Called for every
 * event, so a future field added to the event type cannot quietly start leaking the policy it describes.
 */
export function assertNoSensitiveProviderPolicyEvent(event: ProviderPolicyActivityEvent): void {
  for (const key of Object.keys(event)) {
    if ((FORBIDDEN_EVENT_KEYS as readonly string[]).includes(key)) {
      throw new ProviderDataPolicyError(
        "policy_event_contains_values",
        `A provider policy activity event must not carry "${key}"`,
        { httpStatus: 500, details: { field: key } },
      );
    }
  }
  for (const change of event.changes) {
    // A change entry is a field *name*; `key=value` or `key: value` would be a value.
    if (/[:=]/.test(change)) {
      throw new ProviderDataPolicyError(
        "policy_event_contains_values",
        `Activity change entries must be field names, got "${change}"`,
        { httpStatus: 500, details: { change } },
      );
    }
  }
  if (/(secret|password|passwd|api[_-]?key|bearer)\s*[:=]\s*\S/i.test(JSON.stringify(event))) {
    throw new ProviderDataPolicyError(
      "policy_event_contains_values",
      "A provider policy activity event must not contain a secret value",
      { httpStatus: 500 },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------------

export interface ProviderPolicyView {
  id: string;
  providerId: string;
  modelPattern: string | null;
  policyVersion: number;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: ProviderDataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  region: string | null;
  jurisdiction: string | null;
  requiredRedactions: ProviderRedactionKind[];
  allowedContentTypes: ProviderContentType[];
  termsUrl: string | null;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
  /** True when the review is missing or older than the 180-day trust window. */
  stale: boolean;
  staleReason: string | null;
  /** Human-facing warnings the UI shows next to the row. */
  warnings: string[];
}

export interface ProjectDataPolicyView {
  projectId: string;
  /** What the C5b policy table holds (the authoritative source for provider decisions). */
  dataClassification: ProviderDataClassification;
  /** The project record's own C1 classification, when one could be read. */
  projectRecordClassification: ProviderDataClassification;
  /** The strictest of the two — what the guard and the eligibility answer must use. */
  effectiveClassification: ProviderDataClassification;
  /** True when the project record is what raises the effective value above the C5b row. */
  effectiveFromProjectRecord: boolean;
  pathRules: ProjectDataPolicyPathRule[];
  policyVersion: number;
  /** False when nothing is stored yet and the view is the `confidential` default. */
  configured: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * Reads the project record's own classification (C1). Injected rather than imported so this module keeps
 * no dependency on the project service, and so a deployment without that reader still gets the
 * conservative `confidential` floor instead of "no constraint".
 */
export interface ProjectClassificationPort {
  readProjectClassification(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<ProviderDataClassification | null>;
}

export interface ProviderEligibilityCandidate {
  providerId: string;
  model?: string | null;
  /**
   * What the provider registry says about this provider. Absent means "unknown", which the resolver
   * treats as a hosted third party — the least trusted kind.
   */
  kind?: ProviderDataPolicyKind | null;
}

export interface ProviderEligibilityEntry {
  providerId: string;
  model: string | null;
  eligible: boolean;
  reasons: string[];
  hosted: boolean;
  requiresHostedConsent: boolean;
  hostedConsentGranted: boolean;
  dataClassification: ProviderDataClassification;
  maxDataClassification: ProviderDataClassification;
  allowedContentTypes: ProviderContentType[];
  policySource: string;
  policyVersion: number | null;
  stale: boolean;
  staleReason: string | null;
}

export interface ProviderEligibilityReport {
  projectId: string;
  dataClassification: ProviderDataClassification;
  contentTypes: ProviderContentType[];
  entries: ProviderEligibilityEntry[];
  /** The model/provider a code session should use first, when one is eligible. */
  preferred: { providerId: string; model: string | null } | null;
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

export interface UpsertProviderPolicyCommand {
  modelPattern?: string | null;
  kind?: ProviderDataPolicyKind;
  allowPrivateRepoCode?: boolean;
  maxDataClassification?: ProviderDataClassification;
  allowPromptCaching?: boolean;
  externalRetention?: ExternalRetention | string;
  trainingPolicy?: ProviderTrainingPolicy;
  region?: string | null;
  jurisdiction?: string | null;
  requiredRedactions?: readonly ProviderRedactionKind[];
  allowedContentTypes?: readonly ProviderContentType[];
  termsUrl?: string | null;
  lastReviewedAt?: Date | string | null;
  reviewedBy?: string | null;
  /** `undefined` uses the version that was just read, which still refuses a concurrent writer. */
  expectedPolicyVersion?: number | null;
}

export interface UpsertProjectPolicyCommand {
  dataClassification?: ProviderDataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  expectedPolicyVersion?: number | null;
}

export interface ProviderDataPolicyAdminServiceDeps {
  /** Read port. `WorkspaceStore` satisfies it structurally. */
  store: {
    listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
    getProviderDataPolicy(input: {
      companyId: string | null;
      providerId: string;
      modelPattern: string | null;
    }): Promise<ProviderDataPolicyRecord | null>;
    listProviderDataPolicyVersions(
      companyId: string | null,
      providerId?: string,
    ): Promise<ProviderDataPolicyVersionRecord[]>;
    getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null>;
    getHostedProviderConsent(input: {
      companyId: string;
      projectId: string;
      providerId: string;
    }): Promise<ProviderHostedConsentRecord | null>;
  };
  /** The audited writer from `provider-data-policy.ts` (validation → audit → store). */
  policies: ProviderDataPolicyStoreService;
  /** Company role of the caller; `null` means "not a member", which denies everything. */
  resolveRole: (ctx: AuthContext, companyId: string) => Promise<string | null>;
  /** Optional reader for the project record's own (C1) classification; see the effective-classification rule. */
  projectClassification?: ProjectClassificationPort;
  /** Journal and logger for the shared gate. Without the journal every decision refuses (fail closed). */
  rbac?: CodeRbacDeps;
  activity?: ProviderPolicyActivitySink;
  now?: () => Date;
  logger?: { warn(payload: unknown, message?: string): void };
}

const FIELD_ORDER: readonly string[] = [
  "kind",
  "allowPrivateRepoCode",
  "maxDataClassification",
  "allowPromptCaching",
  "externalRetention",
  "trainingPolicy",
  "region",
  "jurisdiction",
  "requiredRedactions",
  "allowedContentTypes",
  "termsUrl",
  "lastReviewedAt",
  "reviewedBy",
];

function actorOf(ctx: AuthContext): string {
  return String(ctx.userId ?? "unknown");
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ProviderDataPolicyError("invalid_policy_field", `Unsupported date: ${String(value)}`, {
      httpStatus: 400,
      details: { field: "lastReviewedAt" },
    });
  }
  return date;
}

/**
 * The authorization anchor. See the file header: role-anchored, deny by default, and the owner-role
 * write surfaces are all authorized by the same gate: the owner role names the privileged permission.
 */
export class ProviderDataPolicyAdminService {
  private readonly store: ProviderDataPolicyAdminServiceDeps["store"];
  private readonly policies: ProviderDataPolicyStoreService;
  private readonly resolveRole: ProviderDataPolicyAdminServiceDeps["resolveRole"];
  private readonly projectClassification?: ProjectClassificationPort;
  private readonly rbacDeps: CodeRbacDeps;
  private readonly activity?: ProviderPolicyActivitySink;
  private readonly clock: () => Date;
  private readonly logger?: ProviderDataPolicyAdminServiceDeps["logger"];

  constructor(deps: ProviderDataPolicyAdminServiceDeps) {
    this.store = deps.store;
    this.policies = deps.policies;
    this.resolveRole = deps.resolveRole;
    this.projectClassification = deps.projectClassification;
    this.rbacDeps = { ...(deps.rbac ?? {}) };
    this.activity = deps.activity;
    this.clock = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  // -- authorization -------------------------------------------------------------------------------

  private permissionFor(action: string): string {
    const permission = requiredPermissionForAction(action);
    if (!permission) {
      // Unreachable while the action map is complete; refusing is still the only safe answer.
      throw new ProviderDataPolicyError("action_not_mapped", `No permission is mapped to ${action}`, {
        httpStatus: 403,
        details: { action },
      });
    }
    return permission;
  }

  /** The company-scoped context every check here uses: role from membership, legacy permissions dropped. */
  private async companyScopedContext(
    ctx: AuthContext,
    companyId: string,
  ): Promise<{ context: AuthContext; role: string | null }> {
    if (classifyPrincipal(ctx) !== "user") {
      // Canonical refusal + journal entry from the shared gate, then an explicit one for this surface.
      await authorizeCodeAction(
        ctx,
        companyId,
        {
          permission: this.permissionFor(CODE_DATA_POLICY_ACTIONS.providerUpsert),
          action: CODE_DATA_POLICY_ACTIONS.providerUpsert,
          policyChange: true,
        },
        this.rbacDeps,
      );
      throw new ProviderDataPolicyError(
        "agent_cannot_change_policy",
        "An agent or service identity cannot change the provider data policy",
        { httpStatus: 403, details: { reason: "agent_cannot_change_policy" } },
      );
    }
    const role = await this.resolveRole(ctx, companyId);
    return { context: Object.assign({}, ctx, { role, companyId, permissions: [] }) as AuthContext, role };
  }

  private async authorizeRead(ctx: AuthContext, companyId: string, action: string): Promise<{ role: string | null }> {
    const { context, role } = await this.companyScopedContext(ctx, companyId);
    await authorizeCodeAction(
      context,
      companyId,
      { permission: this.permissionFor(action), action },
      this.rbacDeps,
    );
    return { role };
  }

  private async authorizeWrite(
    ctx: AuthContext,
    companyId: string,
    action: string,
  ): Promise<{ role: string | null }> {
    const { context, role } = await this.companyScopedContext(ctx, companyId);
    // One mechanism: the shared gate decides, and the company `owner` role holds `code.policy.manage`
    // explicitly. A denial is a denial — nothing here turns it into an allow.
    await authorizeCodeAction(
      context,
      companyId,
      { permission: this.permissionFor(action), action, policyChange: true },
      this.rbacDeps,
    );
    return { role };
  }

  // -- activity ------------------------------------------------------------------------------------

  private async recordActivity(event: Omit<ProviderPolicyActivityEvent, "kind" | "at">): Promise<void> {
    const full: ProviderPolicyActivityEvent = { kind: "provider_policy_decision", at: this.clock().toISOString(), ...event };
    assertNoSensitiveProviderPolicyEvent(full);
    if (!this.activity) return;
    try {
      await this.activity.record(full);
    } catch (error) {
      // The change already happened and is journalled; a failing activity sink must not turn a successful
      // admin action into an error the caller would retry.
      this.logger?.warn({ err: error }, "provider_policy_activity_failed");
    }
  }

  // -- provider policies ---------------------------------------------------------------------------

  async listProviderPolicies(
    ctx: AuthContext,
    companyId: string,
  ): Promise<{ policies: ProviderPolicyView[]; platformDefaults: ProviderPolicyView[] }> {
    await this.authorizeRead(ctx, companyId, CODE_DATA_POLICY_ACTIONS.providerList);
    const [policies, platformDefaults] = await Promise.all([
      this.store.listProviderDataPolicies(companyId),
      this.store.listProviderDataPolicies(null),
    ]);
    const now = this.clock();
    return {
      policies: policies.map((policy) => this.toView(policy, now)),
      platformDefaults: platformDefaults.map((policy) => this.toView(policy, now)),
    };
  }

  private toView(policy: ProviderDataPolicyRecord, now: Date): ProviderPolicyView {
    const warnings: string[] = [];
    if (isPolicyStale(policy, now)) warnings.push(policyStalenessReason(policy, now) ?? "stale");
    if (policy.kind === "hosted_third_party" && policy.maxDataClassification === "public") {
      warnings.push("hosted_provider_limited_to_public");
    }
    if (!policy.reviewedBy) warnings.push("never_reviewed_by_a_person");
    return {
      id: policy.id,
      providerId: policy.providerId,
      modelPattern: policy.modelPattern,
      policyVersion: policy.policyVersion,
      kind: policy.kind,
      allowPrivateRepoCode: policy.allowPrivateRepoCode,
      maxDataClassification: policy.maxDataClassification,
      allowPromptCaching: policy.allowPromptCaching,
      externalRetention: policy.externalRetention,
      trainingPolicy: policy.trainingPolicy,
      region: policy.region,
      jurisdiction: policy.jurisdiction,
      requiredRedactions: policy.requiredRedactions,
      allowedContentTypes: policy.allowedContentTypes,
      termsUrl: policy.termsUrl,
      lastReviewedAt: policy.lastReviewedAt ? new Date(policy.lastReviewedAt).toISOString() : null,
      reviewedBy: policy.reviewedBy,
      updatedAt: new Date(policy.updatedAt).toISOString(),
      stale: isPolicyStale(policy, now),
      staleReason: policyStalenessReason(policy, now),
      warnings,
    };
  }

  /**
   * Upsert one provider policy. The field list of the activity event is computed from the previous row, so
   * a reviewer sees *what* changed without the values being copied anywhere.
   */
  async upsertProviderPolicy(
    ctx: AuthContext,
    companyId: string,
    providerId: string,
    command: UpsertProviderPolicyCommand,
  ): Promise<{ policy: ProviderPolicyView }> {
    await this.authorizeWrite(ctx, companyId, CODE_DATA_POLICY_ACTIONS.providerUpsert);
    const modelPattern = command.modelPattern === undefined ? null : command.modelPattern;
    const current = await this.store.getProviderDataPolicy({ companyId, providerId, modelPattern });
    const actor = actorOf(ctx);

    const input = {
      companyId,
      providerId,
      modelPattern,
      actor,
      kind: command.kind ?? current?.kind ?? "hosted_third_party",
      allowPrivateRepoCode: command.allowPrivateRepoCode ?? current?.allowPrivateRepoCode ?? false,
      maxDataClassification: command.maxDataClassification ?? current?.maxDataClassification ?? "public",
      allowPromptCaching: command.allowPromptCaching ?? current?.allowPromptCaching ?? false,
      externalRetention: command.externalRetention === undefined
        ? (current?.externalRetention ?? "unknown")
        : parseExternalRetention(command.externalRetention),
      trainingPolicy: command.trainingPolicy ?? current?.trainingPolicy ?? "unknown",
      region: command.region === undefined ? current?.region ?? null : command.region,
      jurisdiction: command.jurisdiction === undefined ? current?.jurisdiction ?? null : command.jurisdiction,
      // Mandatory redaction cannot be dropped: an absent list inherits, and validation refuses a list
      // that omits secrets/tokens/keys.
      requiredRedactions: command.requiredRedactions ?? current?.requiredRedactions ?? [...MANDATORY_REDACTIONS],
      allowedContentTypes: command.allowedContentTypes
        ?? current?.allowedContentTypes
        ?? [...FAIL_CLOSED_ALLOWED_CONTENT_TYPES],
      termsUrl: command.termsUrl === undefined ? current?.termsUrl ?? null : command.termsUrl,
      lastReviewedAt: command.lastReviewedAt === undefined
        ? current?.lastReviewedAt ?? null
        : toDate(command.lastReviewedAt),
      reviewedBy: command.reviewedBy === undefined ? current?.reviewedBy ?? null : command.reviewedBy,
      // An explicit version wins; otherwise the version just read is used, which still refuses a
      // concurrent writer instead of silently overwriting their change.
      expectedPolicyVersion: command.expectedPolicyVersion === undefined
        ? (current ? current.policyVersion : null)
        : command.expectedPolicyVersion,
    };

    // Validate before the audited write so an invalid policy is never journalled as applied.
    validateProviderDataPolicyInput(input);

    const record = await this.policies.upsertPolicy(input);
    const changes = current
      ? FIELD_ORDER.filter((field) => {
        const before = (current as unknown as Record<string, unknown>)[field];
        const after = (record as unknown as Record<string, unknown>)[field];
        return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
      })
      : ["created"];

    await this.recordActivity({
      companyId,
      providerId,
      projectId: null,
      action: CODE_DATA_POLICY_ACTIONS.providerUpsert,
      actor,
      decision: "allow",
      policyVersion: record.policyVersion,
      changes,
    });

    return { policy: this.toView(record, this.clock()) };
  }

  async listPolicyVersions(
    ctx: AuthContext,
    companyId: string,
    providerId: string,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    await this.authorizeRead(ctx, companyId, CODE_DATA_POLICY_ACTIONS.providerVersions);
    return this.store.listProviderDataPolicyVersions(companyId, providerId);
  }

  // -- project policy ------------------------------------------------------------------------------

  /**
   * The **effective** project classification: the strictest of the C5b policy row and the project record's
   * own C1 classification.
   *
   * The two tables exist for different reasons (C5b decides what may reach a provider, C1 is the project's
   * classification for display and retention), and a write to either one is authorized by a different
   * surface. Taking the maximum means neither source can quietly *lower* the protection the other one set:
   * a project marked `restricted` in C1 stays restricted for provider decisions even if the C5b row were
   * set to `public`, and vice versa.
   *
   * A project record that cannot be read is treated as `confidential` — the conservative floor — rather
   * than as "no additional constraint".
   */
  private async effectiveProjectClassification(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{ projectRecordClassification: ProviderDataClassification; overridden: boolean }> {
    const read = this.projectClassification;
    if (!read) return { projectRecordClassification: "confidential", overridden: false };
    try {
      const recordClassification = await read.readProjectClassification(ctx, companyId, projectId);
      return {
        projectRecordClassification: recordClassification ?? "confidential",
        overridden: recordClassification !== null,
      };
    } catch (error) {
      this.logger?.warn({ err: error, projectId }, "provider_data_policy_project_classification_unreadable");
      return { projectRecordClassification: "confidential", overridden: false };
    }
  }

  /**
   * The project view. An unconfigured project is `confidential`, never "unspecified"; `dataClassification`
   * is what the C5b table holds, `effectiveClassification` is what the guard must use.
   */
  private async projectView(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<ProjectDataPolicyView> {
    const stored = await this.store.getProjectDataPolicy(companyId, projectId);
    const projectRecord = await this.effectiveProjectClassification(ctx, companyId, projectId);
    const storedClassification: ProviderDataClassification = stored?.dataClassification ?? "confidential";
    const effectiveClassification = strictestClassification(storedClassification, projectRecord.projectRecordClassification);
    return {
      projectId,
      dataClassification: storedClassification,
      projectRecordClassification: projectRecord.projectRecordClassification,
      effectiveClassification,
      /** True when the project record, not the C5b row, is what raises the effective value. */
      effectiveFromProjectRecord: effectiveClassification !== storedClassification,
      pathRules: stored?.pathRules ?? [],
      policyVersion: stored?.policyVersion ?? 0,
      configured: Boolean(stored),
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored ? new Date(stored.updatedAt).toISOString() : null,
    };
  }

  async getProjectPolicy(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectDataPolicyView> {
    await this.authorizeRead(ctx, companyId, CODE_DATA_POLICY_ACTIONS.projectRead);
    return this.projectView(ctx, companyId, projectId);
  }

  /**
   * Change the project classification and/or its path rules.
   *
   * The comparison is made against the **effective** classification (the strictest of the C5b row and the
   * project record), not merely the stored one: with the project record at `restricted` and the C5b row at
   * `public`, asking for `public` is still a request that would lower the protection, so it takes the
   * owner-level action even though the stored value would not change.
   */
  async upsertProjectPolicy(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    command: UpsertProjectPolicyCommand,
  ): Promise<{ policy: ProjectDataPolicyView }> {
    const before = await this.projectView(ctx, companyId, projectId);
    const requested: ProviderDataClassification = command.dataClassification ?? before.dataClassification;
    const lowering = strictestClassification(before.effectiveClassification, requested) === before.effectiveClassification
      && requested !== before.effectiveClassification;

    const action = lowering
      ? CODE_DATA_POLICY_ACTIONS.projectLowerClassification
      : CODE_DATA_POLICY_ACTIONS.projectUpsert;
    await this.authorizeWrite(ctx, companyId, action);

    const record = await this.policies.upsertProjectPolicy({
      companyId,
      projectId,
      actor: actorOf(ctx),
      ...(command.dataClassification === undefined ? {} : { dataClassification: command.dataClassification }),
      ...(command.pathRules === undefined ? {} : { pathRules: command.pathRules }),
      expectedPolicyVersion: command.expectedPolicyVersion === undefined
        ? (before.configured ? before.policyVersion : null)
        : command.expectedPolicyVersion,
    });

    const changes: string[] = [];
    if (record.dataClassification !== before.dataClassification) changes.push("dataClassification");
    if (JSON.stringify(record.pathRules) !== JSON.stringify(before.pathRules)) changes.push("pathRules");

    await this.recordActivity({
      companyId,
      providerId: null,
      projectId,
      action,
      actor: actorOf(ctx),
      decision: "allow",
      policyVersion: record.policyVersion,
      changes: changes.length ? changes : ["no_op"],
    });

    return { policy: await this.projectView(ctx, companyId, projectId) };
  }

  // -- hosted provider consent ---------------------------------------------------------------------

  async grantHostedConsent(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    providerId: string,
  ): Promise<{ consent: ProviderHostedConsentRecord }> {
    await this.authorizeWrite(ctx, companyId, CODE_DATA_POLICY_ACTIONS.hostedConsentGrant);
    const consent = await this.policies.grantHostedConsent({
      companyId,
      projectId,
      providerId,
      actor: actorOf(ctx),
    });
    await this.recordActivity({
      companyId,
      providerId,
      projectId,
      action: CODE_DATA_POLICY_ACTIONS.hostedConsentGrant,
      actor: actorOf(ctx),
      decision: "allow",
      policyVersion: null,
      changes: ["hostedConsent"],
    });
    return { consent };
  }

  async revokeHostedConsent(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    providerId: string,
  ): Promise<{ consent: ProviderHostedConsentRecord }> {
    await this.authorizeWrite(ctx, companyId, CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke);
    const consent = await this.policies.revokeHostedConsent({
      companyId,
      projectId,
      providerId,
      actor: actorOf(ctx),
    });
    await this.recordActivity({
      companyId,
      providerId,
      projectId,
      action: CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke,
      actor: actorOf(ctx),
      decision: "allow",
      policyVersion: null,
      changes: ["hostedConsent"],
    });
    return { consent };
  }

  async getHostedConsent(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    providerId: string,
  ): Promise<{ granted: boolean; grantedAt: string | null; grantedBy: string | null; revokedAt: string | null }> {
    await this.authorizeRead(ctx, companyId, CODE_DATA_POLICY_ACTIONS.projectRead);
    const record = await this.store.getHostedProviderConsent({ companyId, projectId, providerId });
    return {
      granted: Boolean(record && record.revokedAt === null),
      grantedAt: record ? new Date(record.grantedAt).toISOString() : null,
      grantedBy: record?.grantedBy ?? null,
      revokedAt: record?.revokedAt ? new Date(record.revokedAt).toISOString() : null,
    };
  }

  // -- eligibility ---------------------------------------------------------------------------------

  /**
   * Would this provider/model receive the project's data, and if not, why?
   *
   * The predicate is `provider-data-policy.ts` itself (`resolveEffectivePolicy`, `classifyContent`,
   * `policyAllowsClassification`, `policyAllowsContentType`), so the answer the UI shows and the answer
   * the guard enforces come from one implementation. When no candidate is supplied, the stored policies
   * are used, which means an installation with no policy at all reports the fail-closed default rather
   * than an empty "nothing is configured, so everything is fine" list.
   */
  async getEligibility(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { candidates?: readonly ProviderEligibilityCandidate[]; contentTypes?: readonly ProviderContentType[] } = {},
  ): Promise<ProviderEligibilityReport> {
    await this.authorizeRead(ctx, companyId, CODE_DATA_POLICY_ACTIONS.eligibility);
    const project = await this.projectView(ctx, companyId, projectId);
    const contentTypes = input.contentTypes?.length ? [...input.contentTypes] : (["code"] as ProviderContentType[]);

    let candidates = input.candidates ? [...input.candidates] : [];
    if (candidates.length === 0) {
      const stored = await this.store.listProviderDataPolicies(companyId);
      const seen = new Set<string>();
      for (const policy of stored) {
        const key = `${policy.providerId}\u0000${policy.modelPattern ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ providerId: policy.providerId, model: policy.modelPattern, kind: policy.kind });
      }
    }

    const now = this.clock();
    const entries: ProviderEligibilityEntry[] = [];
    for (const candidate of candidates) {
      const resolved = await this.policies.resolveForCompany({
        companyId,
        providerId: candidate.providerId,
        model: candidate.model ?? null,
        providerKind: candidate.kind ?? null,
      });
      const classified = classifyContent({
        contentTypes,
        // The **effective** classification, so a project record marked `restricted` in C1 cannot be
        // undercut by a C5b row that says `public`.
        projectClassification: project.effectiveClassification,
        pathRules: project.pathRules,
        paths: [],
      });
      const reasons: string[] = [];
      if (resolved.source === "fail_closed") reasons.push("no_policy_for_provider");
      if (!policyAllowsClassification(resolved.policy, classified.classification)) {
        reasons.push(`classification_exceeds_policy:${classified.classification}>${resolved.policy.maxDataClassification}`);
      }
      for (const contentType of contentTypes) {
        if (!policyAllowsContentType(resolved.policy, contentType)) {
          reasons.push(`content_type_not_allowed:${contentType}`);
        }
      }
      const hosted = resolved.policy.kind === "hosted_third_party";
      const consent = hosted
        ? await this.policies.hasHostedConsent({ companyId, projectId, providerId: candidate.providerId })
        : true;
      if (hosted && !consent) reasons.push("hosted_consent_required");

      entries.push({
        providerId: candidate.providerId,
        model: candidate.model ?? null,
        eligible: reasons.length === 0,
        reasons,
        hosted,
        requiresHostedConsent: hosted,
        hostedConsentGranted: consent,
        dataClassification: classified.classification,
        maxDataClassification: resolved.policy.maxDataClassification,
        allowedContentTypes: resolved.policy.allowedContentTypes,
        policySource: resolved.source,
        policyVersion: resolved.policyVersion,
        stale: resolved.stale,
        staleReason: resolved.staleReason,
      });
    }

    const preferredEntry = entries.find((entry) => entry.eligible) ?? null;
    return {
      projectId,
      // What the guard must use: the strictest of the C5b row and the project record (C1).
      dataClassification: project.effectiveClassification,
      contentTypes,
      entries,
      preferred: preferredEntry ? { providerId: preferredEntry.providerId, model: preferredEntry.model } : null,
    };
  }

  /** The 180-day review window, exposed so the UI can explain the warning it renders. */
  readonly reviewWindow = {
    checkedAt: () => this.clock().toISOString(),
    stale: (policy: Pick<ProviderDataPolicyRecord, "lastReviewedAt">) => isPolicyStale(policy, this.clock()),
  };
}
