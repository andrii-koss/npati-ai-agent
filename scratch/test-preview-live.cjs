const http = require("http");

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function testPreview() {
  const companyId = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
  const projectId = "715009ee-a7bf-4999-bce2-053d207b7af5";

  // Check status
  const statusRes = await request({
    host: "127.0.0.1",
    port: 3001,
    path: `/companies/${companyId}/projects/${projectId}/preview/status`,
    method: "GET",
  });
  console.log("Preview status response:", statusRes.statusCode, statusRes.body);
}

testPreview().catch(console.error);
