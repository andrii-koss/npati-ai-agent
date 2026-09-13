export interface UrlValidationResult {
  allowed: boolean;
  normalizedUrl?: string;
  reason?: string;
}

export interface DownloadQuarantineResult {
  quarantined: boolean;
  filename: string;
  reason?: string;
}

export interface ActionRiskEvaluation {
  highRisk: boolean;
  requiresApproval: boolean;
  reason?: string;
}

const DANGEROUS_DOWNLOAD_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".sh",
  ".vbs",
  ".dll",
  ".cmd",
  ".scr",
  ".msi",
  ".ps1",
  ".com",
  ".pif",
  ".jar",
]);

const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "npati-agent-api",
  "npati-agent-web",
  "npati-agent-company-worker",
  "npati-agent-postgres",
  "npati-agent-redis",
  "npati-agent-omniroute",
  "npati-agent-minio",
  "postgres",
  "redis",
  "minio",
  "omniroute",
]);

const DANGEROUS_ACTION_SELECTORS = [
  /(?:^|[^a-zA-Z0-9])(delete|remove|drop|wipe|purge|destroy)(?:[^a-zA-Z0-9]|$)/i,
  /(?:^|[^a-zA-Z0-9])(pay|payment|checkout|buy|purchase|transfer|send[-_]?money)(?:[^a-zA-Z0-9]|$)/i,
  /(?:^|[^a-zA-Z0-9])(grant[-_]?admin|elevate|sudo|disable[-_]?mfa|reset[-_]?credentials)(?:[^a-zA-Z0-9]|$)/i,
];

export class BrowserSecurityGuard {
  /**
   * 1. SSRF and Domain Policy Validation
   */
  static validateUrl(
    targetUrl: string,
    options: {
      allowLocalhost?: boolean;
      domainAllowlist?: string[];
      domainBlocklist?: string[];
    } = {}
  ): UrlValidationResult {
    if (!targetUrl || typeof targetUrl !== "string") {
      return { allowed: false, reason: "URL must be a non-empty string" };
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl.trim());
    } catch {
      return { allowed: false, reason: "Malformed URL" };
    }

    // Protocol check: only http and https are permitted
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        allowed: false,
        reason: `Blocked unsafe protocol '${parsed.protocol}'. Only http: and https: are allowed.`,
      };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check internal docker services and loopback
    if (INTERNAL_HOSTNAMES.has(hostname)) {
      if (options.allowLocalhost && (hostname === "localhost" || hostname === "127.0.0.1")) {
        // Allowed for special cases like CDP debugging port
      } else {
        return {
          allowed: false,
          reason: `SSRF_PROTECTION: Access to internal hostname '${hostname}' is prohibited.`,
        };
      }
    }

    // Cloud Metadata endpoint
    if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
      return {
        allowed: false,
        reason: "SSRF_PROTECTION: Access to cloud instance metadata service is prohibited.",
      };
    }

    // Check private IPv4 addresses
    if (this.isPrivateIpv4(hostname)) {
      if (!(options.allowLocalhost && hostname.startsWith("127."))) {
        return {
          allowed: false,
          reason: `SSRF_PROTECTION: Navigation to private IP range '${hostname}' is prohibited.`,
        };
      }
    }

    // Check IPv6 loopback/ULA
    if (hostname === "::1" || hostname === "[::1]" || hostname.startsWith("fc00:") || hostname.startsWith("fd00:")) {
      if (!options.allowLocalhost) {
        return {
          allowed: false,
          reason: `SSRF_PROTECTION: Navigation to private IPv6 range '${hostname}' is prohibited.`,
        };
      }
    }

    // Domain blocklist check
    if (options.domainBlocklist && options.domainBlocklist.length > 0) {
      if (options.domainBlocklist.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
        return {
          allowed: false,
          reason: `Domain '${hostname}' is blocked by company security policy.`,
        };
      }
    }

    // Domain allowlist check
    if (options.domainAllowlist && options.domainAllowlist.length > 0) {
      const allowed = options.domainAllowlist.some(
        (d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`)
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Domain '${hostname}' is not in company allowlist.`,
        };
      }
    }

    return {
      allowed: true,
      normalizedUrl: parsed.toString(),
    };
  }

  /**
   * 2. Download Quarantine Check
   */
  static validateDownload(filename: string): DownloadQuarantineResult {
    const dotIndex = filename.lastIndexOf(".");
    const ext = dotIndex !== -1 ? filename.slice(dotIndex).toLowerCase() : "";

    if (DANGEROUS_DOWNLOAD_EXTENSIONS.has(ext)) {
      return {
        quarantined: true,
        filename,
        reason: `Executable or script extension '${ext}' quarantined by security policy.`,
      };
    }

    return {
      quarantined: false,
      filename,
    };
  }

  /**
   * 3. High-Risk Action Guardrails
   */
  static checkActionRisk(action: string, selector: string): ActionRiskEvaluation {
    const guardedActions = new Set(["click", "submit", "type", "drag_and_drop", "select_option"]);
    if (!guardedActions.has(action)) {
      return { highRisk: false, requiresApproval: false };
    }

    for (const pattern of DANGEROUS_ACTION_SELECTORS) {
      if (pattern.test(selector)) {
        return {
          highRisk: true,
          requiresApproval: true,
          reason: `Selector '${selector}' matches high-risk pattern and requires human approval before execution.`,
        };
      }
    }

    return { highRisk: false, requiresApproval: false };
  }

  private static isPrivateIpv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return false;
    }

    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;

    return false;
  }
}
