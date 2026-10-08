/**
 * G1 (item 3) probe: the registry check is not vacuous.
 *
 * Reads the real files, edits **copies in memory** and prints the verdict of every mutation. Nothing in the
 * repository is modified. Run: `node .g1-probe/registry-nonvacuous.mjs` from the repository root.
 */
import { readdirSync, readFileSync } from "node:fs";
import { validateMigrationRegistry } from "../scripts/migration-registry-check.mjs";

const store = readFileSync("packages/workspace/src/postgres-store.ts", "utf8");
const files = readdirSync("packages/workspace/src");

const verdict = (label, input) => {
  const result = validateMigrationRegistry(input);
  console.log(`${label}: ok=${result.ok} issues=${result.issues.length} codes=[${result.issues.map((issue) => issue.code).join(",")}]`);
  return result;
};

const base = verdict("unmutated repository            ", { storeSource: store, migrationFiles: files });
if (!base.ok) throw new Error("the unmutated registry must be green, otherwise the mutations prove nothing");

const source = (needle) => {
  if (!store.includes(needle)) throw new Error(`probe input not found verbatim: ${needle}`);
  return needle;
};

const noInsert = store.replace(source("INSERT INTO schema_migrations(version) VALUES ('086_project_mounted_folders')"), "SELECT 1");
verdict("one INSERT row removed (086)    ", { storeSource: noInsert, migrationFiles: files });

const noGuard = store.replace(source("SELECT 1 FROM schema_migrations WHERE version='085_mcp_tool_policies'"), "SELECT 1 FROM schema_migrations WHERE version='085_removed'");
verdict("one SELECT guard renamed (085)  ", { storeSource: noGuard, migrationFiles: files });

const duplicate = store.replace(
  source("INSERT INTO schema_migrations(version) VALUES ('084_code_activity_parents')"),
  "INSERT INTO schema_migrations(version) VALUES ('084_code_activity_parents');\n        await client.query(\"INSERT INTO schema_migrations(version) VALUES ('084_code_activity_parents')\")",
);
verdict("one INSERT row duplicated (084) ", { storeSource: duplicate, migrationFiles: files });

verdict("one migration file removed (042)", { storeSource: store, migrationFiles: files.filter((file) => file !== "migration-042.ts") });

verdict("one extra migration file (087)  ", { storeSource: store, migrationFiles: [...files, "migration-087.ts"] });

verdict("one extra file, unregistered    ", { storeSource: store, migrationFiles: [...files, "migration-087_without_registration.ts"] });

const loopBroken = store.replace("await client.query(\"INSERT INTO schema_migrations(version) VALUES ($1)\", [version]);", "await client.query(\"SELECT 1\");");
verdict("the 001-003 loop insert removed ", { storeSource: loopBroken, migrationFiles: files });
