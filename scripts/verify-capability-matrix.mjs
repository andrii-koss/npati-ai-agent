import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Read and parse capability matrix TS file
const matrixFilePath = path.join(rootDir, "packages", "shared", "src", "capability-matrix.ts");
const content = fs.readFileSync(matrixFilePath, "utf-8");

const match = content.match(/export const CAPABILITY_MATRIX: CapabilityMatrixEntry\[\] = (\[[\s\S]*\]);/);
if (!match) {
  console.error("❌ Failed to parse CAPABILITY_MATRIX from capability-matrix.ts");
  process.exit(1);
}

const matrix = eval(match[1]);

console.log("==========================================================");
console.log("  NPATI AGENT — 306 CAPABILITY AUDIT & REGRESSION SUITE   ");
console.log("==========================================================");

// 1. Total items count
if (matrix.length !== 306) {
  console.error(`❌ Expected exactly 306 capabilities, found ${matrix.length}`);
  process.exit(1);
}
console.log(`✓ Total Capabilities: ${matrix.length}/306 verified`);

// 2. Continuous IDs 1 to 306
const idSet = new Set();
for (let i = 1; i <= 306; i++) {
  const item = matrix.find((c) => c.id === i);
  if (!item) {
    console.error(`❌ Missing capability ID #${i}`);
    process.exit(1);
  }
  if (idSet.has(i)) {
    console.error(`❌ Duplicate capability ID #${i}`);
    process.exit(1);
  }
  idSet.add(i);
}
console.log(`✓ Continuous Inventory IDs 1..306: 0 gaps, 0 duplicates`);

// 3. Check agentCallable breakdown (42 tool, 264 non-tool)
const tools = matrix.filter((c) => c.agentCallable);
const nonTools = matrix.filter((c) => !c.agentCallable);
console.log(`✓ Agent-Callable Tools: ${tools.length} (Expected: 42)`);
console.log(`✓ Internal Runtime/Ops Capabilities: ${nonTools.length} (Expected: 264)`);

if (tools.length !== 42 || nonTools.length !== 264) {
  console.error(`❌ Mismatch in agent-callable tools count: got ${tools.length}, expected 42`);
  process.exit(1);
}

// 4. Test file existence check
let missingFiles = 0;
const testFileSet = new Set();

for (const item of matrix) {
  for (const testFile of item.testFiles) {
    testFileSet.add(testFile);
    const absPath = path.join(rootDir, testFile);
    if (!fs.existsSync(absPath)) {
      console.warn(`⚠️ Referenced test file does not exist: ${testFile} (for capability #${item.id} ${item.name})`);
      missingFiles++;
    }
  }
}

console.log(`✓ Unique Test Suites Mapped: ${testFileSet.size}`);
if (missingFiles > 0) {
  console.error(`❌ ${missingFiles} referenced test files are missing from repository!`);
  process.exit(1);
} else {
  console.log(`✓ Test File Integrity: 100% of referenced test files exist on disk`);
}

// 5. Domain Breakdown
const domains = {};
for (const item of matrix) {
  domains[item.domain] = (domains[item.domain] || 0) + 1;
}

console.log("\nCapabilities by Domain:");
for (const [domain, count] of Object.entries(domains)) {
  console.log(`  • ${domain.padEnd(20)}: ${count}`);
}

// 6. Test Type Breakdown
const testTypes = {};
for (const item of matrix) {
  testTypes[item.testType] = (testTypes[item.testType] || 0) + 1;
}

console.log("\nCapabilities by Test Ownership:");
for (const [tType, count] of Object.entries(testTypes)) {
  console.log(`  • ${tType.padEnd(20)}: ${count}`);
}

// 7. Status Breakdown
const statuses = {};
for (const item of matrix) {
  statuses[item.status] = (statuses[item.status] || 0) + 1;
}

console.log("\nCapabilities by Verified Status:");
for (const [status, count] of Object.entries(statuses)) {
  console.log(`  • ${status.padEnd(20)}: ${count}`);
}

console.log("==========================================================");
console.log("  CAPABILITY AUDIT MATRIX VERIFICATION: ALL CHECKS PASSED  ");
console.log("==========================================================\n");
