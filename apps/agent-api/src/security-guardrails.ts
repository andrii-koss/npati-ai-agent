export interface InjectionAnalysisResult {
  safe: boolean;
  riskScore: number; // 0 to 1
  reason?: string;
  matchedPatterns?: string[];
}

const INJECTION_PATTERNS = [
  { regex: /\b(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|directives|rules))\b/i, weight: 0.9, name: "Instruction override" },
  { regex: /\b(you\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak|god|root|admin)\s+mode)\b/i, weight: 0.85, name: "Jailbreak mode switch" },
  { regex: /\b(disregard\s+all\s+safety\s+and\s+system\s+guidelines)\b/i, weight: 0.95, name: "Safety bypass" },
  { regex: /(<\|im_start\|>|<\|im_end\|>|<system>|<\/system>|\[SYSTEM_MESSAGE\])/i, weight: 0.9, name: "System delimiter spoofing" },
  { regex: /\b(system\s+prompt\s*:\s*you\s+must)\b/i, weight: 0.8, name: "System prompt simulation" },
  { regex: /\b(output\s+your\s+(entire\s+)?system\s+instructions?\s+verbatim)\b/i, weight: 0.85, name: "System prompt extraction" },
];

export class PromptInjectionGuard {
  static analyze(text: string): InjectionAnalysisResult {
    if (!text || typeof text !== "string") {
      return { safe: true, riskScore: 0 };
    }

    const matchedPatterns: string[] = [];
    let maxWeight = 0;

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.regex.test(text)) {
        matchedPatterns.push(pattern.name);
        maxWeight = Math.max(maxWeight, pattern.weight);
      }
    }

    const safe = maxWeight < 0.7;
    return {
      safe,
      riskScore: maxWeight,
      reason: safe ? undefined : `Potential prompt injection detected: ${matchedPatterns.join(", ")}`,
      matchedPatterns: matchedPatterns.length > 0 ? matchedPatterns : undefined,
    };
  }

  static assertSafe(text: string): void {
    const analysis = this.analyze(text);
    if (!analysis.safe) {
      throw Object.assign(new Error(analysis.reason || "Security policy violation: prompt injection detected"), {
        status: 400,
        code: "SECURITY_GUARDRAIL_BLOCKED",
      });
    }
  }
}

const SECRET_PATTERNS = [
  { regex: /\b(sk-[A-Za-z0-9_-]{20,80})\b/g, replacement: "[REDACTED_API_KEY]" },
  { regex: /\b(jina_[A-Za-z0-9_-]{20,80})\b/g, replacement: "[REDACTED_JINA_KEY]" },
  { regex: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,100})\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { regex: /\b(Bearer\s+ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, replacement: "Bearer [REDACTED_JWT]" },
  { regex: /(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@[^/]+\/[^\s?]+)/gi, replacement: "$1[REDACTED_PASSWORD]$3" },
  { regex: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED_AWS_KEY]" },
];

export class CredentialMasker {
  static mask(text: string): string {
    if (!text || typeof text !== "string") return text;
    let result = text;
    for (const { regex, replacement } of SECRET_PATTERNS) {
      result = result.replace(regex, replacement);
    }
    return result;
  }

  static maskObject<T>(obj: T): T {
    if (obj == null) return obj;
    if (typeof obj === "string") return this.mask(obj) as unknown as T;
    if (Array.isArray(obj)) return obj.map((item) => this.maskObject(item)) as unknown as T;
    if (typeof obj === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (/token|secret|password|apikey|api_key|auth/i.test(key) && typeof val === "string" && val.length > 8) {
          copy[key] = "[REDACTED_SECRET]";
        } else {
          copy[key] = this.maskObject(val);
        }
      }
      return copy as T;
    }
    return obj;
  }
}

const PII_PATTERNS = [
  // Email addresses
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[REDACTED_EMAIL]" },
  // Credit / Debit card numbers (13 to 19 digits)
  { regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g, replacement: "[REDACTED_PAYMENT_CARD]" },
  // Formatted credit card with spaces/dashes (e.g. 4111 2222 3333 4444)
  { regex: /\b(?:\d{4}[ -]){3}\d{4}\b/g, replacement: "[REDACTED_PAYMENT_CARD]" },
  // Ukrainian IBAN (UA + 27 digits) and general IBAN (15-34 alphanumeric)
  { regex: /\bUA\d{2}[0-9A-Z]{25}\b/gi, replacement: "[REDACTED_IBAN]" },
  // Ukrainian phone numbers (+380...)
  { regex: /(?:\+?380\s*\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2})\b/g, replacement: "[REDACTED_PHONE]" },
  // International E.164 phone numbers
  { regex: /\b\+\d{1,3}[\s-]?(?:\(\d{2,4}\)|\d{2,4})[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, replacement: "[REDACTED_PHONE]" },
  // Ukrainian Tax ID (РНОКПП / ІПН - 10 digits)
  { regex: /(?:ІПН|РНОКПП|tax\s*id|taxid|ipn|rnokpp)\s*[:=]?\s*\d{8,10}\b/gi, replacement: "[REDACTED_TAX_ID]" },
];

export class PiiMasker {
  static mask(text: string): string {
    if (!text || typeof text !== "string") return text;
    let result = text;
    for (const { regex, replacement } of PII_PATTERNS) {
      result = result.replace(regex, replacement);
    }
    return result;
  }

  static maskObject<T>(obj: T): T {
    if (obj == null) return obj;
    if (typeof obj === "string") return this.mask(obj) as unknown as T;
    if (Array.isArray(obj)) return obj.map((item) => this.maskObject(item)) as unknown as T;
    if (typeof obj === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (/email|phone|card|iban|tax_id|rnokpp/i.test(key) && typeof val === "string") {
          copy[key] = this.mask(val);
        } else {
          copy[key] = this.maskObject(val);
        }
      }
      return copy as T;
    }
    return obj;
  }
}

