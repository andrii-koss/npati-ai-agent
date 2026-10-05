/**
 * D7 optional demo (seed) data for schema templates.
 *
 * Seeds are applied to the **dev** environment only: they exist so an agent and the owner can
 * see a working shop/blog/CRM in Live Preview. Promotion never copies them unless the owner
 * explicitly asks for `withData`.
 */

export interface SeedRowSet {
  collection: string;
  rows: Array<Record<string, unknown>>;
}

export interface DataSeed {
  templateId: string;
  description: string;
  sets: SeedRowSet[];
}

export const DATA_SEED_CATALOG: DataSeed[] = [
  {
    templateId: "ecommerce",
    description: "Demo storefront: two categories and four products.",
    sets: [
      {
        collection: "categories",
        rows: [
          { name: "Coffee", slug: "coffee" },
          { name: "Equipment", slug: "equipment" },
        ],
      },
      {
        collection: "products",
        rows: [
          { name: "Ethiopia Yirgacheffe 250g", price: 18.5, description: "Floral, citrus, light roast" },
          { name: "Brazil Santos 1kg", price: 29.0, description: "Nutty, chocolate, medium roast" },
          { name: "Pour-over kettle", price: 54.0, description: "Gooseneck kettle, 1L" },
          { name: "Paper filters (100)", price: 7.5, description: "Size 02, unbleached" },
        ],
      },
    ],
  },
  {
    templateId: "blog",
    description: "Demo blog with one category and two posts.",
    sets: [
      { collection: "categories", rows: [{ name: "Engineering", slug: "engineering" }] },
      {
        collection: "posts",
        rows: [
          { title: "Hello world", body: "First post published from NPATI Data Studio." },
          { title: "Shipping a project", body: "How NPATI promotes dev changes to production." },
        ],
      },
    ],
  },
  {
    templateId: "crm",
    description: "Demo CRM with two contacts and one company.",
    sets: [
      { collection: "companies", rows: [{ name: "Northwind Traders" }] },
      {
        collection: "contacts",
        rows: [
          { name: "Ada Lovelace", email: "ada@example.com" },
          { name: "Grace Hopper", email: "grace@example.com" },
        ],
      },
    ],
  },
];

/** Maximum rows a single seed set may contain; enforced when seeds are applied. */
export const MAX_SEED_ROWS_PER_COLLECTION = 50;

export function getDataSeed(templateId: string): DataSeed | undefined {
  return DATA_SEED_CATALOG.find((seed) => seed.templateId === templateId);
}

/** Seeds only reference collections of their template; a mismatch is a bug, not user input. */
export function validateDataSeed(seed: DataSeed, templateCollections: readonly string[]): string[] {
  const problems: string[] = [];
  for (const set of seed.sets) {
    if (!templateCollections.includes(set.collection)) problems.push(`Seed targets unknown collection: ${set.collection}`);
    if (set.rows.length > MAX_SEED_ROWS_PER_COLLECTION) problems.push(`Seed for ${set.collection} exceeds ${MAX_SEED_ROWS_PER_COLLECTION} rows`);
  }
  return problems;
}
