import { buildApp } from "./app";

const port = Number.parseInt(process.env.NPATI_AGENT_API_PORT ?? "3001", 10);
const app = buildApp({
  webOrigin: process.env.NPATI_WEB_ORIGIN,
  omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL,
  omnirouteApiKey: process.env.OMNIROUTE_API_KEY,
  omnirouteManagementPassword: process.env.OMNIROUTE_MANAGEMENT_PASSWORD,
  omnirouteTranscriptionModel: process.env.OMNIROUTE_TRANSCRIPTION_MODEL,
  dataDirectory: process.env.NPATI_DATA_DIR,
  hubBaseUrl: process.env.NPATI_HUB_BASE_URL,
  hubApiKey: process.env.NPATI_HUB_API_KEY,
  databaseUrl: process.env.DATABASE_URL,
  crawlerBaseUrl: process.env.CRAWL4AI_BASE_URL,
});

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
