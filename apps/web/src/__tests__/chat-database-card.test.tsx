import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ChatDatabaseCard } from "../ChatDatabaseCard";

// V6 step 14 (owner): a created database shows its own block: the name, "PostgreSQL · Data Studio", status, Open,
// all labels in the language of the request.
const card = { id: "b1", name: "V6TEST14 Poly UK Site bakery DB", companyId: "c", projectId: "p", engine: "PostgreSQL", status: "ready" as const };
const html = (language: string, value = card) => renderToStaticMarkup(<MemoryRouter><ChatDatabaseCard card={value} language={language} /></MemoryRouter>);

describe("database block", () => {
  it("shows the database name, engine and Ukrainian labels", () => {
    const markup = html("uk");
    expect(markup).toContain("V6TEST14 Poly UK Site bakery DB");
    expect(markup).toContain("PostgreSQL · Data Studio");
    expect(markup).toContain("Працює");
    expect(markup).toContain("Відкрити");
  });
  it("speaks the request's language", () => {
    expect(html("de")).toContain("Öffnen");
    expect(html("ja")).toContain("開く");
    expect(html("hi")).toContain("खोलें");
  });
  it("keeps the full name in the title and the generic label when there is no name", () => {
    expect(html("en", { ...card, name: "A".repeat(120) })).toContain(`title="${"A".repeat(120)}"`);
    expect(html("uk", { ...card, name: "" })).toContain("База даних");
  });
});
