const { Pool } = require("pg");
const { Client } = require("minio");

const REAL_PROJECT_ID = "715009ee-a7bf-4999-bce2-053d207b7af5";
const REAL_BACKEND_ID = "b5533f4c-de46-4426-adf8-f6631759ee9c";
const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";

const corePool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://npati:b1f58d50ff5b81c16b62ba8a306d179bc5bdb1a959b38b0c0442946c2469f090@postgres:5432/npati_agent",
});

const projectsAdminPool = new Pool({
  connectionString: "postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/postgres",
});

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "npati-isolated-source-20261011-minio-internal",
  port: parseInt(process.env.MINIO_PORT || "9000", 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || "validation-admin",
  secretKey: process.env.MINIO_SECRET_KEY || "ce8f0d6502c25e141bb8c9f728b06e4c28de5bccbf67dd7d3f3f8dfdb67605e8",
});
const BUCKET = "npati-project-media";

async function cleanup() {
  console.log("=== CLEANING UP DISPOSABLE TEST RESOURCES ===");

  // 1. Clean disposable projects from Core DB (excluding REAL_PROJECT_ID)
  const deletedProjects = await corePool.query(
    "DELETE FROM projects WHERE id != $1 AND (name LIKE 'Disposable%' OR name LIKE 'E2E%' OR name LIKE 'Isolated%') RETURNING id, name",
    [REAL_PROJECT_ID]
  );
  console.log(`✓ Deleted ${deletedProjects.rowCount} disposable test project(s) from Core DB`);

  // 2. Clean disposable DataBackends from Core DB (excluding REAL_BACKEND_ID)
  const deletedBackends = await corePool.query(
    "DELETE FROM data_backends WHERE id != $1 AND (name LIKE 'Disposable%' OR name LIKE 'Test%') RETURNING id, name",
    [REAL_BACKEND_ID]
  );
  console.log(`✓ Deleted ${deletedBackends.rowCount} disposable DataBackend(s) from Core DB`);

  // 3. Drop disposable databases in postgres-projects
  const dbs = (await projectsAdminPool.query("SELECT datname FROM pg_database WHERE datname LIKE 'db_%'")).rows.map(r => r.datname);
  const realDev = `db_${REAL_BACKEND_ID.replace(/-/g, "")}_dev`;
  const realProd = `db_${REAL_BACKEND_ID.replace(/-/g, "")}_prod`;

  let droppedDbs = 0;
  for (const dbName of dbs) {
    if (dbName === realDev || dbName === realProd) {
      console.log(`   [PRESERVE] Keeping real store database: ${dbName}`);
      continue;
    }
    try {
      await projectsAdminPool.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      droppedDbs++;
      console.log(`   ✓ Dropped disposable database: ${dbName}`);
    } catch (e) {
      console.warn(`   ! Failed to drop ${dbName}: ${e.message}`);
    }
  }
  console.log(`✓ Cleaned ${droppedDbs} disposable database(s) from postgres-projects`);

  // 4. Remove disposable MinIO objects
  const stream = minioClient.listObjects(BUCKET, "", true);
  let removedObjects = 0;
  for await (const obj of stream) {
    if (!obj.name.includes(REAL_PROJECT_ID)) {
      await minioClient.removeObject(BUCKET, obj.name);
      removedObjects++;
    }
  }
  console.log(`✓ Cleaned ${removedObjects} disposable MinIO asset(s)`);

  // 5. Final verification of real store integrity
  const realCheck = (await corePool.query("SELECT id, name, status, revision FROM projects WHERE id = $1", [REAL_PROJECT_ID])).rows[0];
  console.log(`✓ Real store project status: "${realCheck.name}" [${realCheck.id}] -> Status: ${realCheck.status}, Rev: ${realCheck.revision}`);

  await corePool.end();
  await projectsAdminPool.end();
  console.log("=== CLEANUP FINISHED SUCCESSFULLY ===");
}

cleanup().catch(err => {
  console.error("CLEANUP ERROR:", err);
  process.exit(1);
});
