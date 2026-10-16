import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const providerRoot = path.join(root, "vendor", "omniroute", "src", "shared", "constants", "providers");
const providerIconFile = path.join(root, "vendor", "omniroute", "src", "shared", "components", "ProviderIcon.tsx");
const lobeIconFile = path.join(root, "vendor", "omniroute", "src", "shared", "components", "lobeProviderIcons.ts");
const providerAssetRoot = path.join(root, "vendor", "omniroute", "public", "providers");
const versionPath = path.join(root, "OMNIROUTE_VERSION");
const versionFile = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, "utf8") : "";
// Source checkouts pin OmniRoute through the git submodule; release archives may supply the version file.
const version = versionFile.match(/^OMNIROUTE_VERSION=(.+)$/m)?.[1] ?? `v${JSON.parse(fs.readFileSync(path.join(root, "vendor", "omniroute", "package.json"), "utf8")).version}`;
const commit = versionFile.match(/^OMNIROUTE_COMMIT=(.+)$/m)?.[1] ?? execFileSync("git", ["-C", path.join(root, "vendor", "omniroute"), "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
const output = path.join(root, "packages", "omniroute-adapter", "src", "generated", "provider-catalog.json");

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(target) : entry.name.endsWith(".ts") ? [target] : [];
  });
}

function categoryFor(file) {
  const relative = path.relative(providerRoot, file).replaceAll("\\", "/");
  if (relative.startsWith("apikey/")) return "api-key";
  return path.basename(relative, ".ts").replaceAll("_", "-");
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : null;
}

function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(literal).filter((value) => value !== undefined);
  }
  if (ts.isObjectLiteralExpression(node)) return objectLiteral(node);
  return undefined;
}

function objectLiteral(node) {
  const value = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    const resolved = literal(property.initializer);
    if (name && resolved !== undefined) value[name] = resolved;
  }
  return value;
}

function unwrapExpression(node) {
  while (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function constantObject(file, constantName) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let result = {};
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== constantName || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isObjectLiteralExpression(initializer)) result = objectLiteral(initializer);
    }
  });
  return result;
}

const localIconAliases = constantObject(providerIconFile, "LOCAL_SVG_ALIASES");
const providerIconAliases = constantObject(providerIconFile, "PROVIDER_ICON_ALIASES");
const themedIcons = constantObject(providerIconFile, "THEMED_SVGS");
const lobeIconAliases = constantObject(lobeIconFile, "LOBE_PROVIDER_ALIASES");
const providerAssets = fs.readdirSync(providerAssetRoot)
  .filter((file) => /\.(svg|png|jpe?g|webp)$/i.test(file));
const assetsByStem = new Map(providerAssets.map((file) => [path.basename(file, path.extname(file)).toLowerCase(), file]));

function iconMetadata(provider) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const normalized = value.toLowerCase().trim();
    if (/^[a-z0-9._-]+$/.test(normalized) && !candidates.includes(normalized)) candidates.push(normalized);
  };
  const id = provider.id.toLowerCase();
  add(id);
  add(provider.alias);
  add(providerIconAliases[id]);
  add(localIconAliases[id]);
  add(lobeIconAliases[id]?.replace(/[^a-z0-9]/gi, ""));
  let family = id;
  const suffixes = /-(?:web|cli|cloud|search|api|apikey|ai|cn|local|coding|plan)$/;
  while (suffixes.test(family)) {
    family = family.replace(suffixes, "");
    add(family);
  }
  add(String(provider.name ?? "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""));

  const themed = themedIcons[id];
  const themedAsset = typeof themed?.light === "string" ? path.basename(themed.light) : undefined;
  const iconAsset = themedAsset && providerAssets.includes(themedAsset)
    ? themedAsset
    : candidates.map((candidate) => assetsByStem.get(candidate)).find(Boolean);
  return {
    ...(iconAsset ? { iconAsset: `/providers/${iconAsset}` } : {}),
    iconFallbackIds: candidates,
  };
}

const providers = [];
for (const file of filesIn(providerRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.includes("_PROVIDERS")) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
        const key = propertyName(property.name);
        if (!key) continue;
        const metadata = objectLiteral(property.initializer);
        const provider = { ...metadata, id: typeof metadata.id === "string" ? metadata.id : key, category: categoryFor(file) };
        providers.push({ ...provider, ...iconMetadata(provider) });
      }
    }
  });
}

const unique = [...new Map(providers.map((provider) => [provider.id, provider])).values()]
  .sort((left, right) => left.id.localeCompare(right.id));

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ sourceVersion: version, sourceCommit: commit, providers: unique }, null, 2)}\n`);
console.log(`Generated ${unique.length} providers from OmniRoute ${version}.`);
