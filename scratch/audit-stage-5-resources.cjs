const { Client } = require("minio");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
const PROJECT_ID = "715009ee-a7bf-4999-bce2-053d207b7af5";

const corePool = new Pool({
  connectionString: "postgresql://npati:b1f58d50ff5b81c16b62ba8a306d179bc5bdb1a959b38b0c0442946c2469f090@postgres:5432/npati_agent",
});

const projectsPool = new Pool({
  connectionString: "postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/postgres",
});

const minioClient = new Client({
  endPoint: "npati-isolated-source-20261011-minio-internal",
  port: 9000,
  useSSL: false,
  accessKey: "validation-admin",
  secretKey: "ce8f0d6502c25e141bb8c9f728b06e4c28de5bccbf67dd7d3f3f8dfdb67605e8",
});

async function audit() {
  console.log("================================================================================");
  console.log(`AUDIT & DRY-RUN: Resources for Project ${PROJECT_ID} in Company ${COMPANY_ID}`);
  console.log("================================================================================\n");

  // 1. Core Project Record
  const projectRes = await corePool.query("SELECT * FROM projects WHERE id = $1", [PROJECT_ID]);
  const project = projectRes.rows[0];
  console.log("1. CORE PROJECT RECORD:");
  if (project) {
    console.log(`   - Name: ${project.name}`);
    console.log(`   - Status: ${project.status}`);
    console.log(`   - Type: ${project.type}`);
    console.log(`   - DataBackend ID: ${project.data_backend_id || "none"}`);
    console.log(`   - Sandbox ID: ${project.sandbox_id || "none"}`);
    console.log(`   - Created By: ${project.created_by}`);
    console.log(`   - Created At: ${project.created_at}`);
  } else {
    console.log("   - [NOT FOUND in projects table]");
  }

  // 2. Scan all tables in Core DB with project_id
  console.log("\n2. CORE DATABASE (npati_agent) TABLES:");
  const tablesRes = await corePool.query(
    "SELECT table_name FROM information_schema.columns WHERE column_name = 'project_id' AND table_schema = 'public' ORDER BY table_name"
  );
  let totalCoreRows = 0;
  for (const row of tablesRes.rows) {
    const countRes = await corePool.query(`SELECT COUNT(*) FROM "${row.table_name}" WHERE project_id = $1`, [PROJECT_ID]);
    const count = parseInt(countRes.rows[0].count, 10);
    if (count > 0) {
      console.log(`   - ${row.table_name}: ${count} rows`);
      totalCoreRows += count;
    }
  }
  console.log(`   Total related rows across core tables: ${totalCoreRows}`);

  // 3. DataBackend & Shared DB status
  console.log("\n3. DATA BACKEND & SHARED DATABASE USAGE:");
  if (project && project.data_backend_id) {
    const backendRes = await corePool.query("SELECT * FROM data_backends WHERE id = $1", [project.data_backend_id]);
    const backend = backendRes.rows[0];
    if (backend) {
      console.log(`   - Backend ID: ${backend.id}`);
      console.log(`   - Backend Name: ${backend.name}`);
      console.log(`   - Backend Status: ${backend.status}`);

      // Check all projects referencing this data_backend_id
      const sharingRes = await corePool.query(
        "SELECT id, name, type, status FROM projects WHERE data_backend_id = $1",
        [backend.id]
      );
      console.log(`   - Projects sharing this backend (${sharingRes.rows.length}):`);
      for (const p of sharingRes.rows) {
        const isCurrent = p.id === PROJECT_ID ? " [THIS PROJECT]" : " [OTHER PROJECT/APP - SHARED!]";
        console.log(`     * ${p.id} (${p.name}, type: ${p.type}, status: ${p.status})${isCurrent}`);
      }

      // Check databases in postgres-projects
      const safeId = backend.id.replace(/-/g, "");
      const devDb = `db_${safeId}_dev`;
      const prodDb = `db_${safeId}_prod`;
      console.log(`   - Target PostgreSQL Databases in postgres-projects:`);
      console.log(`     * Dev DB: ${devDb}`);
      console.log(`     * Prod DB: ${prodDb}`);

      // Count collections & rows in devDb
      try {
        const devPool = new Pool({
          connectionString: `postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/${devDb}`,
        });
        const tablesInDev = await devPool.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
        );
        console.log(`     * Dev DB Tables (${tablesInDev.rows.length}): ${tablesInDev.rows.map(t => t.table_name).join(", ")}`);
        await devPool.end();
      } catch (err) {
        console.log(`     * Dev DB status check failed: ${err.message}`);
      }
    }
  } else {
    console.log("   - No DataBackend attached.");
  }

  // 4. MinIO Object Storage
  console.log("\n4. MINIO OBJECT STORAGE (npati-project-media):");
  const mediaPrefix = `${COMPANY_ID}/${PROJECT_ID}/`;
  let mediaCount = 0;
  let mediaBytes = 0;
  try {
    for await (const obj of minioClient.listObjectsV2("npati-project-media", mediaPrefix, true)) {
      mediaCount++;
      mediaBytes += obj.size;
      console.log(`   - [Object] ${obj.name} (${obj.size} bytes, modified: ${obj.lastModified})`);
    }
  } catch (err) {
    console.log(`   - Error reading bucket: ${err.message}`);
  }
  console.log(`   Total MinIO media files: ${mediaCount} (${mediaBytes} bytes)`);

  // Check exports / snapshots in MinIO
  console.log("\n5. MINIO EXPORTS & BACKUPS (npati-exports):");
  let exportCount = 0;
  try {
    for await (const obj of minioClient.listObjectsV2("npati-exports", `${COMPANY_ID}/`, true)) {
      if (obj.name.includes(PROJECT_ID)) {
        exportCount++;
        console.log(`   - [Export] ${obj.name} (${obj.size} bytes)`);
      }
    }
  } catch {
    // ignore
  }
  if (exportCount === 0) console.log("   - No project-specific export bundles found.");

  // 6. On-Disk Workspace
  console.log("\n6. ON-DISK WORKSPACE:");
  const workspacePath = `/app/data/project-workspaces/${COMPANY_ID}/${PROJECT_ID}`;
  try {
    const stat = fs.statSync(workspacePath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(workspacePath);
      console.log(`   - Path: ${workspacePath} (EXISTS)`);
      console.log(`   - Root Files / Dirs (${files.length}): ${files.slice(0, 15).join(", ")}${files.length > 15 ? "..." : ""}`);
    }
  } catch {
    console.log(`   - Path: ${workspacePath} [NOT FOUND]`);
  }

  // 7. On-Disk Snapshots / Backups
  console.log("\n7. ON-DISK SNAPSHOTS & BACKUPS (/app/project-snapshots):");
  try {
    const snapshots = fs.readdirSync("/app/project-snapshots");
    const matching = snapshots.filter(s => s.includes(PROJECT_ID) || (project?.data_backend_id && s.includes(project.data_backend_id.replace(/-/g, ""))));
    console.log(`   - Found ${matching.length} snapshots matching project / backend:`);
    for (const s of matching) {
      console.log(`     * /app/project-snapshots/${s}`);
    }
  } catch (err) {
    console.log(`   - Snapshot dir check: ${err.message}`);
  }

  console.log("\n================================================================================");
  console.log("AUDIT COMPLETE - ZERO MUTATIONS PERFORMED (DRY-RUN)");
  console.log("================================================================================\n");

  await corePool.end();
  await projectsPool.end();
}

audit().catch(console.error);
