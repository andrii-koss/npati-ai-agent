import { describe, expect, it } from "vitest";
import { NPATI_BUCKETS, objectKey, objectKeySegment } from "../apps/agent-api/src/object-storage";

describe("NPATI object storage", () => {
  it("uses a bounded set of private system buckets", () => {
    expect(Object.values(NPATI_BUCKETS)).toEqual([
      "npati-chat-files",
      "npati-company-knowledge",
      "npati-generated-media",
      "npati-exports",
    ]);
  });

  it("supports authenticated workspace IDs without weakening path validation", () => {
    const a = objectKeySegment("workspace:user-a"), b = objectKeySegment("workspace:user-b");
    expect(a).not.toBe(b);
    expect(a).toBe(objectKeySegment("workspace:user-a"));
    expect(() => objectKey(["workspace", a, "companies", "company-a"])).not.toThrow();
    expect(objectKeySegment("dev-workspace")).toBe("dev-workspace");
    expect(objectKeySegment("../private")).not.toContain("/");
  });

  it("builds tenant-scoped keys and blocks traversal/user paths", () => {
    expect(objectKey(["workspace", "workspace-a", "user", "user-a", "chats", "chat-id", "images", "file-id"]))
      .toBe("workspace/workspace-a/user/user-a/chats/chat-id/images/file-id");
    expect(() => objectKey(["workspace", "..", "secret"])).toThrow(/unsafe segment/);
    expect(() => objectKey(["workspace", "folder/name"])).toThrow(/unsafe segment/);
    expect(() => objectKey([])).toThrow(/unsafe segment/);
  });
});
