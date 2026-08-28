import type { ServiceHealth } from "@npati/shared";

export interface HubClient {
  getConnections(): Promise<unknown[]>;
  getCapabilities(): Promise<string[]>;
  createSocialDraft(input: unknown): Promise<unknown>;
  scheduleSocialPost(input: unknown): Promise<unknown>;
  createListing(input: unknown): Promise<unknown>;
  createWordPressDraft(input: unknown): Promise<unknown>;
  publishWordPressPost(input: unknown): Promise<unknown>;
  healthCheck(): Promise<ServiceHealth>;
}

export class FoundationHubClient implements HubClient {
  constructor(private readonly configured: boolean) {}

  getConnections(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  getCapabilities(): Promise<string[]> {
    return Promise.resolve([]);
  }

  private unavailable(): never {
    throw new Error("NPATI Hub operations are not enabled in the foundation milestone");
  }

  createSocialDraft(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  scheduleSocialPost(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  createListing(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  createWordPressDraft(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  publishWordPressPost(): Promise<unknown> { return Promise.reject(this.unavailable()); }

  healthCheck(): Promise<ServiceHealth> {
    return Promise.resolve(
      this.configured
        ? { status: "degraded", detail: "Configured; transport implementation is pending" }
        : { status: "not_configured", detail: "NPATI Hub is optional for local startup" },
    );
  }
}

export function createHubClient(config: { baseUrl?: string; apiKey?: string } = {}): HubClient {
  return new FoundationHubClient(Boolean(config.baseUrl && config.apiKey));
}

