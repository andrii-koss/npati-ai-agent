const http = require("http");
const { Client } = require("minio");
const fs = require("fs");
const path = require("path");

const minioClient = new Client({
  endPoint: "npati-isolated-source-20261011-minio-internal",
  port: 9000,
  useSSL: false,
  accessKey: "validation-admin",
  secretKey: "ce8f0d6502c25e141bb8c9f728b06e4c28de5bccbf67dd7d3f3f8dfdb67605e8",
});

const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
const PROJECT_ID = "715009ee-a7bf-4999-bce2-053d207b7af5";
const BUCKET = "npati-project-media";
const OBJECT_KEY = `${COMPANY_ID}/${PROJECT_ID}/assets/hero-banner.png`;

// Valid PNG 1x1 image buffer
const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:3001${urlPath}`, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
  });
}

async function run() {
  console.log("=== STEP 1: Put test image into MinIO ===");
  await minioClient.putObject(BUCKET, OBJECT_KEY, PNG_BUFFER, PNG_BUFFER.length, {
    "content-type": "image/png",
    "x-amz-meta-original-name": "hero-banner.png",
  });
  console.log("Object stored in MinIO:", OBJECT_KEY, PNG_BUFFER.length, "bytes");

  console.log("\n=== STEP 2: Verify stat from MinIO directly ===");
  const stat = await minioClient.statObject(BUCKET, OBJECT_KEY);
  console.log("MinIO stat size:", stat.size, "content-type:", stat.metaData["content-type"]);
  if (stat.size !== PNG_BUFFER.length) throw new Error("Size mismatch in MinIO");

  console.log("\n=== STEP 3: Stream image via agent-api /api/projects/:id/media/* ===");
  const mediaUrl = `/api/projects/${PROJECT_ID}/media/assets/hero-banner.png`;
  const res1 = await httpGet(mediaUrl);
  console.log("HTTP status:", res1.statusCode);
  console.log("Content-Type:", res1.headers["content-type"]);
  console.log("Content-Length:", res1.headers["content-length"]);
  console.log("X-Content-Type-Options:", res1.headers["x-content-type-options"]);
  console.log("Body:", res1.body.toString("utf8"));
  if (res1.statusCode !== 200) throw new Error("Expected 200 OK from media stream: " + res1.body.toString("utf8"));
  if (res1.headers["content-type"] !== "image/png") throw new Error("Expected image/png Content-Type");
  if (res1.headers["x-content-type-options"] !== "nosniff") throw new Error("Expected nosniff header");
  if (res1.body.length !== PNG_BUFFER.length) throw new Error("Body length mismatch");

  console.log("\n=== STEP 4: Cross-Project Isolation (Project B unauthorized access) ===");
  const forbiddenUrl = `/api/projects/unknown-project-9999/media/assets/hero-banner.png`;
  const res2 = await httpGet(forbiddenUrl);
  console.log("Cross-project query HTTP status:", res2.statusCode);
  if (res2.statusCode !== 404) throw new Error("Expected 404 for non-existent/other project");

  console.log("\n=== STEP 5: Path Traversal Protection ===");
  const traversalUrl = `/api/projects/${PROJECT_ID}/media/..%2f..%2fetc%2fpasswd`;
  const res3 = await httpGet(traversalUrl);
  console.log("Traversal attempt HTTP status:", res3.statusCode);
  if (res3.statusCode === 200) throw new Error("Directory traversal must be rejected!");

  console.log("\nSTAGE_4_LIVE_CHECKS_PASSED");
}

run().catch((err) => {
  console.error("FATAL ERROR in live checks:", err);
  process.exit(1);
});
