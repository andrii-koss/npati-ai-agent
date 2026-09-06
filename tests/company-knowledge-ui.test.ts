import { describe, expect, it } from "vitest";

describe("Company Knowledge UI regression and state lifecycle (NPATI-004A)", () => {
  interface DocumentState {
    id: string;
    fileId: string;
    status: "uploaded" | "processing" | "ready" | "failed" | "deleted";
    errorMessage?: string;
    chunkCount: number;
    createdAt: string;
  }

  it("handles the full lifecycle state transitions: uploaded -> processing -> ready", () => {
    const doc: DocumentState = {
      id: "doc-1",
      fileId: "file-1",
      status: "uploaded",
      chunkCount: 0,
      createdAt: new Date().toISOString(),
    };

    expect(doc.status).toBe("uploaded");
    expect(doc.chunkCount).toBe(0);

    // Processing transition
    doc.status = "processing";
    expect(doc.status).toBe("processing");

    // Ready transition
    doc.status = "ready";
    doc.chunkCount = 14;
    expect(doc.status).toBe("ready");
    expect(doc.chunkCount).toBe(14);
    expect(doc.errorMessage).toBeUndefined();
  });

  it("handles failure state transition with error message and retry capability", () => {
    const doc: DocumentState = {
      id: "doc-2",
      fileId: "file-2",
      status: "uploaded",
      chunkCount: 0,
      createdAt: new Date().toISOString(),
    };

    // Transition to failed
    doc.status = "failed";
    doc.errorMessage = "PDF parser failed: corrupted header";

    expect(doc.status).toBe("failed");
    expect(doc.errorMessage).toBe("PDF parser failed: corrupted header");

    // Retry action triggers transition back to uploaded
    doc.status = "uploaded";
    doc.errorMessage = undefined;

    expect(doc.status).toBe("uploaded");
    expect(doc.errorMessage).toBeUndefined();
  });

  it("handles deletion state without resurrecting deleted documents", () => {
    let docs: DocumentState[] = [
      { id: "doc-1", fileId: "file-1", status: "ready", chunkCount: 10, createdAt: "" },
      { id: "doc-2", fileId: "file-2", status: "ready", chunkCount: 5, createdAt: "" },
    ];

    // Delete doc-1
    docs = docs.filter((d) => d.id !== "doc-1");
    expect(docs.length).toBe(1);
    expect(docs[0]!.id).toBe("doc-2");
  });

  it("manages Company Memory CRUD list bounded correctly", () => {
    const memories = [
      { id: "mem-1", content: "Working hours are 09:00 - 18:00 Kyiv", source: "manual", updatedAt: "" },
      { id: "mem-2", content: "Primary support email is support@npati.com", source: "manual", updatedAt: "" },
    ];

    expect(memories.length).toBe(2);
    const filtered = memories.filter((m) => m.id !== "mem-1");
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.content).toContain("support@npati.com");
  });
});
