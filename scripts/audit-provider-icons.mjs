import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const catalogPath = path.join(root, "packages", "omniroute-adapter", "src", "generated", "provider-catalog.json");
const vendorProvidersDir = path.join(root, "vendor", "omniroute", "public", "providers");
const overridesPath = path.join(root, "packages", "omniroute-adapter", "src", "provider-icon-overrides.ts");

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const vendorFiles = new Set(fs.readdirSync(vendorProvidersDir).map((f) => f.toLowerCase()));

console.log(`Total providers in catalog: ${catalog.providers.length}`);
console.log(`Total files in vendor/omniroute/public/providers: ${vendorFiles.size}`);

const matched = [];
const missing = [];

for (const provider of catalog.providers) {
  const current = provider.iconAsset ? provider.iconAsset.replace("/providers/", "").toLowerCase() : null;
  if (current && vendorFiles.has(current)) {
    matched.push({ id: provider.id, name: provider.name, file: current });
  } else {
    missing.push(provider);
  }
}

console.log(`Working iconAsset in vendor: ${matched.length}`);
console.log(`Missing / Unmapped providers: ${missing.length}`);

console.log("\n--- Missing Providers Breakdown ---");
missing.forEach((p, idx) => {
  console.log(`${idx + 1}. [${p.id}] "${p.name}" (website: ${p.website || "N/A"})`);
});
