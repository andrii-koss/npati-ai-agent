import { expect, it } from "vitest";
import { resolveContextualCompanyFollowUp } from "../apps/agent-api/src/chat-intent-helpers";

const link = "[Відкрити налаштування компанії →](/settings/company?company=bd53b535-f6ea-437a-a21d-50df76d4d80b)";

it("'так' after an agent-setup offer becomes that setup request", () => {
  const offer = "Готово, я створив компанію V6TEST_Bakery2. " + link + "\nНаступний крок: хочете, щоб я детальніше налаштував ролі, інструкції та моделі для цих агентів?";
  expect(resolveContextualCompanyFollowUp("так", offer)).toMatch(/^Детально налаштуй ролі/u);
});

// Live V6 step 03: the reply offered to update the Business Profile description and carried the usual company link;
// "так" was rewritten into an agent-setup command and answered with an unrelated email error.
it("'так' after another offer in a company reply stays the user's own answer", () => {
  const offer = "Опис компанії V6TEST_Bakery2 оновлено. " + link + "\nХочете, щоб я також оновив опис у бізнес-профілі цієї компанії, щоб дані збігалися?";
  expect(resolveContextualCompanyFollowUp("так", offer)).toBe("так");
  expect(resolveContextualCompanyFollowUp("ок", offer)).toBe("ок");
});
