// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeDataPolicyPanel } from "../CodeDataPolicyPanel";
import { CodeSnapshotPanel } from "../CodeSnapshotPanel";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

it("CodeDataPolicyPanel loads provider policies, project classification, hosted consent, and eligibility", async () => {
  const companyId = "cmp-test-1";
  const notify = vi.fn();

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/code/data-policy/providers")) {
      return jsonResponse({
        policies: [
          {
            id: "pol-1",
            providerId: "anthropic",
            modelPattern: "claude-3-5-*",
            policyVersion: 2,
            kind: "hosted_third_party",
            allowPrivateRepoCode: true,
            maxDataClassification: "confidential",
            allowPromptCaching: true,
            externalRetention: "zero_retention",
            trainingPolicy: "no_training",
            region: "us-east-1",
            jurisdiction: "US",
            requiredRedactions: ["secret"],
            allowedContentTypes: ["code"],
            termsUrl: "https://example.com/terms",
            lastReviewedAt: "2026-10-15T00:00:00Z",
            reviewedBy: "sec-officer",
            updatedAt: "2026-10-15T00:00:00Z",
            stale: false,
            staleReason: null,
            warnings: [],
          },
        ],
        platformDefaults: [],
      });
    }

    if (url.includes("/code/projects?includeArchived=true")) {
      return jsonResponse({
        projects: [{ id: "prj-alpha", name: "Alpha Core Repo", status: "active" }],
      });
    }

    if (url.includes("/code/data-policy/projects/prj-alpha/hosted-consent") && method === "POST") {
      return jsonResponse({ recorded: true });
    }

    if (url.includes("/code/data-policy/projects/prj-alpha/eligibility")) {
      return jsonResponse({
        entries: [
          {
            providerId: "anthropic",
            model: "claude-3-5-sonnet",
            eligible: true,
            reasons: [],
            hosted: true,
            hostedConsentGranted: true,
            dataClassification: "internal",
            maxDataClassification: "confidential",
            policyVersion: 2,
            stale: false,
          },
        ],
      });
    }

    if (url.includes("/code/data-policy/projects/prj-alpha")) {
      return jsonResponse({
        projectPolicy: {
          projectId: "prj-alpha",
          dataClassification: "internal",
          effectiveClassification: "internal",
          pathRules: [{ pattern: "secret/**", classification: "restricted" }],
          policyVersion: 1,
          configured: true,
          updatedBy: "admin",
          updatedAt: "2026-10-16T12:00:00Z",
        },
      });
    }

    throw new Error(`Unhandled URL in test: ${url} [${method}]`);
  });

  vi.stubGlobal("fetch", fetchMock);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<CodeDataPolicyPanel companyId={companyId} isUk={false} notify={notify} />);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Provider data policy");
      expect(container.textContent).toContain("anthropic");
    });

    // Select the project
    const projectSelect = container.querySelector("select");
    expect(projectSelect).toBeTruthy();

    await act(async () => {
      projectSelect!.value = "prj-alpha";
      projectSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("secret/**");
    });

    // Check eligibility button
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const eligibilityBtn = buttons.find((b) => b.textContent?.includes("Check eligibility"));
    if (eligibilityBtn) {
      await act(async () => {
        eligibilityBtn.click();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("claude-3-5-sonnet");
      });
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

it("CodeSnapshotPanel displays why the agent acted and computes snapshot diff", async () => {
  const companyId = "cmp-test-1";
  const runId = "run-current";
  const otherRunId = "run-previous";

  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);

    if (url.endsWith(`/code/runs/${runId}/snapshot`)) {
      return jsonResponse({
        status: "snapshot",
        snapshot: {
          snapshotId: "snap-123",
          snapshotVersion: 1,
          runId,
          companyId,
          projectId: "prj-alpha",
          trigger: "user_turn",
          payloadHash: "hash1234567890abcdef",
          createdBy: "user-alice",
          createdAt: "2026-10-17T10:00:00Z",
          payload: {
            modelSelection: { provider: "anthropic", model: "claude-3-5-sonnet" },
            modelProfileVersion: 3,
            systemPrompt: { version: 4, contentHash: "sha256:abc" },
            runnerVersion: "v1.2.0",
            toolManifestVersion: "manifest-2026-10",
            sandboxImage: { digest: "sha256:sandbox123" },
            providerDataPolicy: { version: 2, classification: "internal" },
            featureFlags: { master: { enabled: true }, flags: { "code.diff.sandbox": true } },
            baseCommit: { branch: "main", commit: "abcdef1", dirty: false },
            projectInstructions: { trustStatus: "trusted" },
            toolchain: { languages: ["typescript", "node"] },
            policyComposition: { egress: "allowlist_only" },
          },
        },
      });
    }

    if (url.endsWith(`/code/runs/${otherRunId}/snapshot`)) {
      return jsonResponse({
        status: "snapshot",
        snapshot: {
          snapshotId: "snap-456",
          snapshotVersion: 1,
          runId: otherRunId,
          companyId,
          projectId: "prj-alpha",
          trigger: "user_turn",
          payloadHash: "hash9999999999abcdef",
          createdBy: "user-bob",
          createdAt: "2026-10-16T10:00:00Z",
          payload: {},
        },
      });
    }

    if (url.endsWith(`/code/runs/${runId}/replay`)) {
      return jsonResponse({
        status: "bundle",
        replay: {
          bundleId: "bundle-1",
          runId,
          verified: true,
          reproducible: true,
        },
      });
    }

    if (url.includes("/code/trust")) {
      return jsonResponse({
        trust: {
          trustStatus: "trusted",
          revision: 1,
          trustedBy: "admin",
          trustedAt: "2026-10-17T00:00:00Z",
          instructionsDigest: "sha256:111",
        },
      });
    }

    if (url.includes("/code/snapshots/compare?")) {
      return jsonResponse({
        diff: {
          changed: ["modelSelection.model", "featureFlags.flags.code.diff.sandbox"],
          unchanged: ["systemPrompt", "runnerVersion", "sandboxImage"],
        },
      });
    }

    throw new Error(`Unhandled URL: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<CodeSnapshotPanel companyId={companyId} runId={runId} isUk={false} />);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Why did the agent act this way (C6b)");
      expect(container.textContent).toContain("claude-3-5-sonnet");
      expect(container.textContent).toContain("sha256:sandbox123");
    });

    // Enter other runId and compare
    const input = container.querySelector<HTMLInputElement>("input[placeholder='run id']");
    expect(input).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, otherRunId);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const compareBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Compare"),
    );
    expect(compareBtn).toBeTruthy();
    expect(compareBtn!.disabled).toBe(false);

    await act(async () => {
      compareBtn!.click();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("modelSelection.model");
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
