export type BulkRecord = { id: string; ownerId: string };
export type BulkDeleteBody = { records: BulkRecord[] };

export const bulkDeleteSchema = {
  body: {
    type: "object",
    required: ["records"],
    additionalProperties: false,
    properties: {
      records: {
        type: "array", minItems: 1, maxItems: 1000,
        items: {
          type: "object", required: ["id", "ownerId"], additionalProperties: false,
          properties: { id: { type: "string", minLength: 1, maxLength: 128 }, ownerId: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
  },
};

export async function collectBulkRecords(load: (cursor?: string) => Promise<{ records: BulkRecord[]; nextCursor: string | null }>) {
  const records = new Map<string, BulkRecord>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    for (const record of page.records) records.set(record.id, record);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { records: [...records.values()] };
}

export async function deleteBulkRecords(records: BulkRecord[], remove: (record: BulkRecord) => Promise<boolean>) {
  const unique = [...new Map(records.map(record => [JSON.stringify([record.ownerId, record.id]), record])).values()];
  const failed: BulkRecord[] = [];
  let deleted = 0;
  for (let offset = 0; offset < unique.length; offset += 8) {
    await Promise.all(unique.slice(offset, offset + 8).map(async record => {
      try {
        if (await remove(record)) deleted++;
      } catch {
        failed.push(record);
      }
    }));
  }
  return { deleted, failed };
}
