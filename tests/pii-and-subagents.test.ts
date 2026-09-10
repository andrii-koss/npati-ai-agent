import { describe, expect, it, vi } from "vitest";
import { PiiMasker } from "../apps/agent-api/src/security-guardrails";
import { CompanyKnowledgeRepository } from "../apps/agent-api/src/company-knowledge";
import type { AuthContext } from "@npati/workspace";

describe("PII Masker, Hybrid Memory Search & Multi-Agent Parallel Delegation", () => {
  const ctx: AuthContext = {
    workspaceId: "ws-test",
    userId: "user-test",
    permissions: ["workspace:read", "business:manage"],
    role: "owner",
  };

  describe("PII Masker & Privacy Protection (OpenClaw Item 123 / P1)", () => {
    it("redacts emails, credit cards, Ukrainian phone numbers, IBANs, and Tax IDs", () => {
      const sensitiveText =
        "Клієнт Іван (ivan.petrenko@example.com, тел: +380 (67) 123-45-67), карта 4111 2222 3333 4444, IBAN UA123456789012345678901234567, РНОКПП: 1234567890.";

      const masked = PiiMasker.mask(sensitiveText);

      expect(masked).not.toContain("ivan.petrenko@example.com");
      expect(masked).not.toContain("+380 (67) 123-45-67");
      expect(masked).not.toContain("4111 2222 3333 4444");
      expect(masked).not.toContain("UA123456789012345678901234567");
      expect(masked).not.toContain("1234567890");

      expect(masked).toContain("[REDACTED_EMAIL]");
      expect(masked).toContain("[REDACTED_PHONE]");
      expect(masked).toContain("[REDACTED_PAYMENT_CARD]");
      expect(masked).toContain("[REDACTED_IBAN]");
      expect(masked).toContain("[REDACTED_TAX_ID]");
    });

    it("redacts sensitive fields in nested JSON objects", () => {
      const userProfile = {
        name: "Олена",
        email: "olena.test@business.ua",
        phone: "+380501112233",
        metadata: {
          card: "5105105105105105",
          notes: "Regular customer",
        },
      };

      const masked = PiiMasker.maskObject(userProfile);

      expect(masked.email).toBe("[REDACTED_EMAIL]");
      expect(masked.phone).toBe("[REDACTED_PHONE]");
      expect(masked.metadata.card).toBe("[REDACTED_PAYMENT_CARD]");
      expect(masked.metadata.notes).toBe("Regular customer");
    });
  });

  describe("Hybrid Memory Search (OpenClaw Items 89, 90, 177, 180 / P1)", () => {
    it("searches company memories by keyword with tenant isolation", async () => {
      const mockMemories = [
        {
          id: "mem-1",
          workspaceId: ctx.workspaceId,
          companyId: "comp-1",
          userId: ctx.userId,
          content: "Клієнт вимагає доставку лише Новою Поштою до 18:00.",
          source: "manual",
          metadata: {},
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const mockQuery = vi.fn().mockResolvedValue({ rows: mockMemories });
      const repo = new CompanyKnowledgeRepository("postgres://fake:fake@localhost/db");
      (repo as any).pool = { query: mockQuery };

      const results = await repo.searchMemories(ctx, "comp-1", "Новою Поштою", 10);

      expect(results.length).toBe(1);
      expect(results[0]?.content).toContain("Новою Поштою");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("websearch_to_tsquery('simple'"),
        [ctx.workspaceId, "comp-1", ctx.userId, "Новою Поштою", 10]
      );
    });
  });
});
