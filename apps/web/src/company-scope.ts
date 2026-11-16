export const ALL_COMPANIES = "all";

/** Bound cross-company reads so a large company catalog does not flood the API. */
export async function loadCompanyScopes<T>(ids: readonly string[], load: (id: string) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(ids.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      results[index] = await load(ids[index]!);
    }
  }));
  return results;
}
