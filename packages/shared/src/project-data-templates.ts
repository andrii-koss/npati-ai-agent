export interface TemplateField {
  name: string;
  type: "string" | "text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "uuid" | "enum" | "file_reference";
  required?: boolean;
  default?: string | number | boolean | null;
  options?: string[];
}

export interface TemplateRelation {
  collection: string;
  target: string;
  name: string;
  cardinality: "many-to-one" | "one-to-many" | "many-to-many";
}

export interface TemplateAccessPolicy {
  collection: string;
  rule: "public" | "authenticated" | "owner" | "role";
  ownerField?: string;
  role?: string;
  description?: string;
}

export type GdprStrategy = "delete" | "anonymize" | "detach" | "retain";

export interface DataSchemaTemplate {
  id: "ecommerce" | "blog" | "crm" | "saas-basic" | string;
  name: string;
  description: string;
  category: "commerce" | "content" | "business" | "saas";
  collections: Array<{
    name: string;
    isPrivate?: boolean;
    fields: TemplateField[];
  }>;
  relations: TemplateRelation[];
  accessPolicies: TemplateAccessPolicy[];
  gdprStrategies: Record<string, GdprStrategy>;
}

export const KNOWN_PRIVATE_COLLECTIONS = new Set([
  "carts", "cart_items", "orders", "order_items", "addresses",
  "contacts", "notes", "deals",
  "organizations", "memberships", "subscriptions",
  "comments",
]);

export function validateTemplate(template: DataSchemaTemplate): void {
  if (!template || typeof template !== "object") {
    throw new Error("Invalid schema template: template object is required");
  }
  if (!template.id || !template.name) {
    throw new Error("Invalid schema template: id and name are required");
  }
  if (!Array.isArray(template.collections) || template.collections.length === 0) {
    throw new Error("Invalid schema template: at least one collection is required");
  }

  const collectionNames = new Set(template.collections.map((c) => c.name));

  // Check relations refer to defined collections
  for (const rel of template.relations ?? []) {
    if (!collectionNames.has(rel.collection)) {
      throw new Error(`Invalid relation: source collection "${rel.collection}" does not exist in template`);
    }
    if (!collectionNames.has(rel.target)) {
      throw new Error(`Invalid relation: target collection "${rel.target}" does not exist in template`);
    }
  }

  // Enforce Access Policies for Private Collections (D3 Requirement 11)
  const policiesByCollection = new Map<string, TemplateAccessPolicy[]>();
  for (const policy of template.accessPolicies ?? []) {
    const list = policiesByCollection.get(policy.collection) ?? [];
    list.push(policy);
    policiesByCollection.set(policy.collection, list);
  }

  for (const col of template.collections) {
    const isPrivate = col.isPrivate || KNOWN_PRIVATE_COLLECTIONS.has(col.name);
    if (isPrivate) {
      const policies = policiesByCollection.get(col.name);
      if (!policies || policies.length === 0) {
        const error = new Error(`Private collection "${col.name}" must declare owner-based access policies`);
        Object.assign(error, { code: "TEMPLATE_POLICY_MISSING", status: 400 });
        throw error;
      }
      const hasOwnerRule = policies.some((p) => p.rule === "owner" && p.ownerField);
      if (!hasOwnerRule) {
        const error = new Error(`Private collection "${col.name}" must declare an owner-based access policy with ownerField`);
        Object.assign(error, { code: "TEMPLATE_POLICY_MISSING", status: 400 });
        throw error;
      }
    }
  }
}

export const TEMPLATE_CATALOG: DataSchemaTemplate[] = [
  {
    id: "ecommerce",
    name: "E-Commerce Store",
    description: "Complete database schema for online stores: categories, products, variants, carts, orders, and addresses.",
    category: "commerce",
    collections: [
      {
        name: "categories",
        fields: [
          { name: "name", type: "string", required: true },
          { name: "slug", type: "string", required: true },
          { name: "description", type: "text" },
        ],
      },
      {
        name: "products",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "slug", type: "string", required: true },
          { name: "description", type: "text" },
          { name: "price", type: "decimal", required: true },
          { name: "category_id", type: "uuid" },
          { name: "is_active", type: "boolean", default: true },
        ],
      },
      {
        name: "product_variants",
        fields: [
          { name: "product_id", type: "uuid", required: true },
          { name: "sku", type: "string", required: true },
          { name: "title", type: "string", required: true },
          { name: "price", type: "decimal", required: true },
          { name: "inventory_count", type: "integer", default: 0 },
        ],
      },
      {
        name: "carts",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "status", type: "string", default: "active" },
          { name: "currency", type: "string", default: "UAH" },
        ],
      },
      {
        name: "cart_items",
        isPrivate: true,
        fields: [
          { name: "cart_id", type: "uuid", required: true },
          { name: "variant_id", type: "uuid", required: true },
          { name: "quantity", type: "integer", default: 1 },
          { name: "owner_id", type: "uuid", required: true },
        ],
      },
      {
        name: "orders",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "order_number", type: "string", required: true },
          { name: "status", type: "string", default: "pending" },
          { name: "total_amount", type: "decimal", required: true },
          { name: "currency", type: "string", default: "UAH" },
          { name: "shipping_address", type: "json" },
        ],
      },
      {
        name: "order_items",
        isPrivate: true,
        fields: [
          { name: "order_id", type: "uuid", required: true },
          { name: "product_id", type: "uuid", required: true },
          { name: "variant_id", type: "uuid" },
          { name: "quantity", type: "integer", required: true },
          { name: "unit_price", type: "decimal", required: true },
          { name: "owner_id", type: "uuid", required: true },
        ],
      },
      {
        name: "addresses",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "recipient_name", type: "string", required: true },
          { name: "phone", type: "string", required: true },
          { name: "city", type: "string", required: true },
          { name: "street", type: "string", required: true },
          { name: "postal_code", type: "string" },
          { name: "is_default", type: "boolean", default: false },
        ],
      },
    ],
    relations: [
      { collection: "products", target: "categories", name: "category", cardinality: "many-to-one" },
      { collection: "product_variants", target: "products", name: "product", cardinality: "many-to-one" },
      { collection: "cart_items", target: "carts", name: "cart", cardinality: "many-to-one" },
      { collection: "cart_items", target: "product_variants", name: "variant", cardinality: "many-to-one" },
      { collection: "order_items", target: "orders", name: "order", cardinality: "many-to-one" },
      { collection: "order_items", target: "products", name: "product", cardinality: "many-to-one" },
    ],
    accessPolicies: [
      { collection: "categories", rule: "public" },
      { collection: "products", rule: "public" },
      { collection: "product_variants", rule: "public" },
      { collection: "carts", rule: "owner", ownerField: "owner_id" },
      { collection: "cart_items", rule: "owner", ownerField: "owner_id" },
      { collection: "orders", rule: "owner", ownerField: "owner_id" },
      { collection: "order_items", rule: "owner", ownerField: "owner_id" },
      { collection: "addresses", rule: "owner", ownerField: "owner_id" },
    ],
    gdprStrategies: {
      carts: "delete",
      cart_items: "delete",
      orders: "retain",
      order_items: "retain",
      addresses: "anonymize",
    },
  },
  {
    id: "blog",
    name: "Blog & Publications",
    description: "Publishing platform schema: posts, categories, tags, and reader comments.",
    category: "content",
    collections: [
      {
        name: "categories",
        fields: [
          { name: "name", type: "string", required: true },
          { name: "slug", type: "string", required: true },
          { name: "description", type: "text" },
        ],
      },
      {
        name: "tags",
        fields: [
          { name: "name", type: "string", required: true },
          { name: "slug", type: "string", required: true },
        ],
      },
      {
        name: "posts",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "slug", type: "string", required: true },
          { name: "content", type: "text" },
          { name: "category_id", type: "uuid" },
          { name: "published_at", type: "datetime" },
          { name: "is_published", type: "boolean", default: false },
        ],
      },
      {
        name: "comments",
        isPrivate: true,
        fields: [
          { name: "post_id", type: "uuid", required: true },
          { name: "owner_id", type: "uuid", required: true },
          { name: "author_name", type: "string", required: true },
          { name: "content", type: "text", required: true },
          { name: "is_approved", type: "boolean", default: true },
        ],
      },
    ],
    relations: [
      { collection: "posts", target: "categories", name: "category", cardinality: "many-to-one" },
      { collection: "comments", target: "posts", name: "post", cardinality: "many-to-one" },
    ],
    accessPolicies: [
      { collection: "categories", rule: "public" },
      { collection: "tags", rule: "public" },
      { collection: "posts", rule: "public" },
      { collection: "comments", rule: "owner", ownerField: "owner_id" },
    ],
    gdprStrategies: {
      comments: "anonymize",
      posts: "detach",
    },
  },
  {
    id: "crm",
    name: "CRM & Sales Pipeline",
    description: "Customer relationship management: companies, contacts, sales deals, and notes.",
    category: "business",
    collections: [
      {
        name: "companies",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "name", type: "string", required: true },
          { name: "domain", type: "string" },
          { name: "industry", type: "string" },
        ],
      },
      {
        name: "contacts",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "first_name", type: "string", required: true },
          { name: "last_name", type: "string" },
          { name: "email", type: "string" },
          { name: "phone", type: "string" },
          { name: "company_id", type: "uuid" },
        ],
      },
      {
        name: "deals",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "title", type: "string", required: true },
          { name: "value", type: "decimal" },
          { name: "currency", type: "string", default: "USD" },
          { name: "stage", type: "string", default: "lead" },
          { name: "contact_id", type: "uuid" },
          { name: "company_id", type: "uuid" },
        ],
      },
      {
        name: "notes",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "content", type: "text", required: true },
          { name: "deal_id", type: "uuid" },
          { name: "contact_id", type: "uuid" },
        ],
      },
    ],
    relations: [
      { collection: "contacts", target: "companies", name: "company", cardinality: "many-to-one" },
      { collection: "deals", target: "contacts", name: "contact", cardinality: "many-to-one" },
      { collection: "deals", target: "companies", name: "company", cardinality: "many-to-one" },
      { collection: "notes", target: "deals", name: "deal", cardinality: "many-to-one" },
    ],
    accessPolicies: [
      { collection: "companies", rule: "owner", ownerField: "owner_id" },
      { collection: "contacts", rule: "owner", ownerField: "owner_id" },
      { collection: "deals", rule: "owner", ownerField: "owner_id" },
      { collection: "notes", rule: "owner", ownerField: "owner_id" },
    ],
    gdprStrategies: {
      contacts: "delete",
      notes: "anonymize",
      deals: "retain",
      companies: "detach",
    },
  },
  {
    id: "saas-basic",
    name: "SaaS Foundation",
    description: "Multi-tenant SaaS foundation: organizations, team memberships, and active subscriptions.",
    category: "saas",
    collections: [
      {
        name: "organizations",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "name", type: "string", required: true },
          { name: "slug", type: "string", required: true },
        ],
      },
      {
        name: "memberships",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "org_id", type: "uuid", required: true },
          { name: "user_id", type: "uuid", required: true },
          { name: "role", type: "string", default: "member" },
        ],
      },
      {
        name: "subscriptions",
        isPrivate: true,
        fields: [
          { name: "owner_id", type: "uuid", required: true },
          { name: "org_id", type: "uuid", required: true },
          { name: "plan", type: "string", required: true },
          { name: "status", type: "string", default: "active" },
          { name: "current_period_end", type: "datetime" },
        ],
      },
    ],
    relations: [
      { collection: "memberships", target: "organizations", name: "organization", cardinality: "many-to-one" },
      { collection: "subscriptions", target: "organizations", name: "organization", cardinality: "many-to-one" },
    ],
    accessPolicies: [
      { collection: "organizations", rule: "owner", ownerField: "owner_id" },
      { collection: "memberships", rule: "owner", ownerField: "owner_id" },
      { collection: "subscriptions", rule: "owner", ownerField: "owner_id" },
    ],
    gdprStrategies: {
      memberships: "delete",
      subscriptions: "retain",
      organizations: "retain",
    },
  },
];

export const BUILTIN_DATA_TEMPLATES = TEMPLATE_CATALOG;
