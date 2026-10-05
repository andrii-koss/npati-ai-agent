import { randomUUID } from "node:crypto";

/**
 * Mobile build provider boundary (D6).
 *
 * D6 creates and previews `mobile_app` projects, but does not build store binaries:
 * Apple/Google accounts, signing credentials and store review are outside this step.
 * The interface below is the seam a later step (store publishing, high-risk + approval)
 * will implement, e.g. an `EasBuildProvider` on top of EAS Build.
 */

export interface BuildScope {
  workspaceId: string;
  userId: string;
  companyId: string;
  projectId: string;
}

export type MobilePlatform = "ios" | "android";

export interface BuildTargetConfig {
  provider: "eas" | string;
  /** EAS build profile, for example `development`, `preview` or `production`. */
  profile?: string;
  /** Provider-side project identifier (EAS project id or slug). */
  providerProjectId?: string;
  /** Store track/application identifiers, filled by the future publishing step. */
  bundleIdentifier?: string;
  packageName?: string;
}

export interface BuildRequest {
  target: BuildTargetConfig;
  platforms: MobilePlatform[];
  /** Git commit or workspace revision the build should use. */
  commit?: string;
  appVersion?: string;
}

export interface BuildResult {
  buildId: string;
  status: "queued" | "building" | "succeeded" | "failed";
  platform?: MobilePlatform;
  artifacts?: string[];
  logsUrl?: string;
  startedAt: string;
  finishedAt?: string;
}

export class BuildError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export interface BuildProvider {
  readonly name: string;
  validateConfig(target: BuildTargetConfig, credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }>;
  startBuild(scope: BuildScope, request: BuildRequest, credentials: Record<string, string>): Promise<BuildResult>;
  getBuildStatus(scope: BuildScope, buildId: string, credentials: Record<string, string>): Promise<BuildResult>;
}

const UNCONFIGURED_MESSAGE =
  "BUILD_PROVIDER_UNCONFIGURED: building store binaries (iOS/Android) is not available yet. " +
  "D6 covers mobile_app projects, Expo Web Live Preview and the shared Project API/Auth only; " +
  "store builds need Apple/Google accounts and signing keys and are implemented in a later step as a high-risk action with approval.";

/**
 * Default provider until a store-build step lands. Keeps the boundary explicit instead of
 * silently pretending a build happened.
 */
export class UnconfiguredBuildProvider implements BuildProvider {
  readonly name = "unconfigured";

  async validateConfig(_target: BuildTargetConfig, _credentials: Record<string, string>) {
    return { valid: false, error: UNCONFIGURED_MESSAGE };
  }

  async startBuild(_scope: BuildScope, _request: BuildRequest, _credentials: Record<string, string>): Promise<BuildResult> {
    throw new BuildError("BUILD_PROVIDER_UNCONFIGURED", UNCONFIGURED_MESSAGE, 503, false);
  }

  async getBuildStatus(_scope: BuildScope, buildId: string, _credentials: Record<string, string>): Promise<BuildResult> {
    // A build id can only exist for a configured provider; report it as unknown rather than faking progress.
    return { buildId: buildId || randomUUID(), status: "failed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  }
}

/**
 * TODO(store publishing step): implement `EasBuildProvider` with:
 *  - credentials from the Company secret storage (EXPO_TOKEN), never from the sandbox or Project Context;
 *  - `eas build --platform ios|android --profile <profile> --non-interactive` inside the sandbox runner
 *    or the provider API, with the same allowlist and rate limits as other outbound calls;
 *  - build artefacts stored in project object storage, status polled through `getBuildStatus`;
 *  - store submission as a separate high-risk capability requiring human approval.
 */
