const { Pool } = require("pg");
const { randomUUID, createHash } = require("crypto");
const http = require("http");

const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
const WORKSPACE_ID = "workspace:599402b8-b9d5-4676-a391-7b9db1a77026";
const USER_ID = "599402b8-b9d5-4676-a391-7b9db1a77026";
const REAL_PROJECT_ID = "715009ee-a7bf-4999-bce2-053d207b7af5";

const corePool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://npati:b1f58d50ff5b81c16b62ba8a306d179bc5bdb1a959b38b0c0442946c2469f090@postgres:5432/npati_agent",
});

const projectsAdminPool = new Pool({
  connectionString: "postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/postgres",
});

async function main() {
  const runId = process.argv[2] || Math.random().toString(36).substring(2, 8);
  const cleanId = runId.replace(/[^a-z0-9]/g, "");
  const dispBackendId = `disp-db-s6-${cleanId}`;
  const devDbName = `db_${dispBackendId.replace(/-/g, "")}_dev`;
  const prodDbName = `db_${dispBackendId.replace(/-/g, "")}_prod`;
  const projA_Id = `disp-proj-s6a-${cleanId}`;
  const projB_Id = `disp-proj-s6b-${cleanId}`;

  console.log(`[SETUP] Initializing Stage 6 Disposable Store Contour (runId: ${cleanId})...`);

  // 1. Create dedicated databases in postgres-projects
  await projectsAdminPool.query(`CREATE DATABASE "${devDbName}"`);
  await projectsAdminPool.query(`CREATE DATABASE "${prodDbName}"`);
  console.log(`[SETUP] Created databases: ${devDbName}, ${prodDbName}`);

  // 2. Connect to dev database and provision schema
  const devPool = new Pool({
    connectionString: `postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/${devDbName}`,
  });

  await devPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price NUMERIC(10, 2) NOT NULL,
      image_url VARCHAR(500),
      stock INTEGER DEFAULT 10,
      badge VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) REFERENCES users(id),
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255) NOT NULL,
      total_amount NUMERIC(10, 2) NOT NULL,
      status VARCHAR(50) DEFAULT 'confirmed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id VARCHAR(64) PRIMARY KEY,
      order_id VARCHAR(64) REFERENCES orders(id),
      product_id VARCHAR(64) REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(10, 2) NOT NULL
    );
  `);

  await devPool.query(`
    INSERT INTO products (id, name, description, price, image_url, stock) VALUES
      ('prod-1', 'Mechanical Pro Keyboard', 'RGB Mechanical Gaming Keyboard with tactile switches', 89.99, '/api/projects/${projA_Id}/media/assets/keyboard.svg', 15),
      ('prod-2', 'Wireless Precision Mouse', 'Ultra-lightweight ergonomic wireless mouse', 49.99, '/api/projects/${projA_Id}/media/assets/mouse.svg', 25),
      ('prod-3', 'Studio Gaming Headset', 'Noise-canceling spatial audio surround headset', 119.99, '/api/projects/${projA_Id}/media/assets/headset.svg', 10);
  `);
  console.log(`[SETUP] Seeded 3 products in ${devDbName}`);
  await devPool.end();

  // 3. Register DataBackend in Core PostgreSQL
  const now = new Date().toISOString();
  await corePool.query(
    `INSERT INTO data_backends (id, workspace_id, company_id, created_by, name, provider, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'shared_postgres', 'ready', $6, $6)`,
    [dispBackendId, WORKSPACE_ID, COMPANY_ID, USER_ID, `Disposable E2E Backend ${cleanId}`, now]
  );
  for (const env of ["dev", "prod"]) {
    await corePool.query(
      `INSERT INTO data_backend_environments (id, workspace_id, company_id, backend_id, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [randomUUID(), WORKSPACE_ID, COMPANY_ID, dispBackendId, env, now]
    );
  }

  // 4. Create Project A and Project B
  const toolchainJson = JSON.stringify({ framework: "nextjs" });
  await corePool.query(
    `INSERT INTO projects (id, workspace_id, company_id, name, type, toolchain, status, data_backend_id, revision, created_by, create_request_key, data_classification, retention_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'website', $5, 'ready', $6, 1, $7, $8, 'confidential', 'standard', $9, $9)`,
    [projA_Id, WORKSPACE_ID, COMPANY_ID, `E2E TechStore (${cleanId})`, toolchainJson, dispBackendId, USER_ID, `req-key-${projA_Id}`, now]
  );
  await corePool.query(
    `INSERT INTO projects (id, workspace_id, company_id, name, type, toolchain, status, data_backend_id, revision, created_by, create_request_key, data_classification, retention_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'website', $5, 'ready', $6, 1, $7, $8, 'confidential', 'standard', $9, $9)`,
    [projB_Id, WORKSPACE_ID, COMPANY_ID, `Isolated Site B (${cleanId})`, toolchainJson, dispBackendId, USER_ID, `req-key-${projB_Id}`, now]
  );
  console.log(`[SETUP] Projects created: ${projA_Id}, ${projB_Id}`);

  // 5. Upload media via MinIO
  const { Client } = require("minio");
  const minioClient = new Client({
    endPoint: process.env.MINIO_ENDPOINT || "npati-isolated-source-20261011-minio-internal",
    port: parseInt(process.env.MINIO_PORT || "9000", 10),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || "validation-admin",
    secretKey: process.env.MINIO_SECRET_KEY || "ce8f0d6502c25e141bb8c9f728b06e4c28de5bccbf67dd7d3f3f8dfdb67605e8",
  });
  const BUCKET = "npati-project-media";
  const keyboardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#38bdf8" font-family="sans-serif" font-size="12" text-anchor="middle">Keyboard</text></svg>`;
  const mouseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#4ade80" font-family="sans-serif" font-size="12" text-anchor="middle">Mouse</text></svg>`;
  const headsetSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#fb923c" font-family="sans-serif" font-size="12" text-anchor="middle">Headset</text></svg>`;

  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/keyboard.svg`, Buffer.from(keyboardSvg), keyboardSvg.length, { "content-type": "image/svg+xml" });
  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/mouse.svg`, Buffer.from(mouseSvg), mouseSvg.length, { "content-type": "image/svg+xml" });
  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/headset.svg`, Buffer.from(headsetSvg), headsetSvg.length, { "content-type": "image/svg+xml" });
  console.log(`[SETUP] Uploaded MinIO media under ${COMPANY_ID}/${projA_Id}/assets/`);

  await corePool.end();
  await projectsAdminPool.end();

  console.log(JSON.stringify({
    ok: true,
    runId: cleanId,
    projA: projA_Id,
    projB: projB_Id,
    backendId: dispBackendId,
    devDbName,
    prodDbName,
  }));
}

main().catch(err => {
  console.error("[SETUP FAILED]", err);
  process.exit(1);
});
