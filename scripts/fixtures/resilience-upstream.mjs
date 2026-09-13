import { createServer } from "node:http";

const models = [
  { id: "broken/primary", name: "Fault-injected primary", provider: "openai" },
  { id: "auto/chat:free", name: "Healthy fallback", provider: "openai" },
];

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: "ok" }));
  }
  if (request.method === "GET" && request.url === "/api/v1/provider-plugin-manifest") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ providers: [{
      id: "openai", name: "Resilience E2E upstream", authType: "none", free: true,
      capabilities: ["chat"], models,
    }] }));
  }
  if (request.method === "GET" && request.url === "/api/providers") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ connections: [{
      id: "fault-connection", provider: "openai", isActive: true, testStatus: "active",
    }] }));
  }
  if (request.method === "GET" && request.url === "/api/providers/fault-connection/models") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ models }));
  }
  if (request.method === "GET" && request.url === "/api/monitoring/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ version: "resilience-e2e", providerSummary: { catalogCount: 1 } }));
  }
  if (request.method === "POST" && request.url === "/api/v1/chat/completions") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}");
    if (payload.model === "broken/primary" || payload.model === "openai/broken/primary") {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "fault injection: primary temporarily unavailable" } }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    response.writeHead(200, {
      "content-type": "application/json",
      "x-omniroute-provider": "fault",
      "x-omniroute-routing-strategy": "fallback",
    });
    return response.end(JSON.stringify({
      model: payload.model,
      choices: [{ message: { content: "Production fallback response" } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
});

server.listen(4010, "0.0.0.0");