// scripts/verify-production-p12-multimodal.mjs
// E2E Verification of P1.2 Multimodal Tools & Media Gateway against live Docker runtime

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const stamp = Date.now();
let token = "";

console.log("==========================================================");
console.log("  NPATI AGENT — P1.2 MULTIMODAL TOOLS LIVE DOCKER E2E     ");
console.log("==========================================================\n");

function assert(condition, message, extra = "") {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`, extra);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function api(path, method = "GET", body = undefined, customHeaders = {}) {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(isMutating ? { "idempotency-key": `idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...customHeaders,
  };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, data: json };
}

async function run() {
  // 1. Auth guard verification
  console.log("[1/15] Verifying Auth Guards on /media endpoints...");
  const unauthRes = await fetch(`${base}/media/providers`);
  assert(unauthRes.status === 401, "Unauthenticated access to /media/providers rejected with 401");

  // 2. Admin login
  console.log("\n[2/15] Authenticating admin user against live container...");
  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.tokens?.accessToken) {
    throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
  }
  token = login.tokens.accessToken;
  console.log("✓ Admin login successful, JWT obtained");

  // 3. Provider Discovery
  console.log("\n[3/15] Verifying Media Provider Discovery (GET /media/providers)...");
  const providersRes = await api("/media/providers");
  assert(providersRes.ok, `Providers fetched: ${providersRes.status}`);
  assert(Array.isArray(providersRes.data.providers?.imageGenerators), "Image generators listed");
  assert(Array.isArray(providersRes.data.providers?.videoEngines), "Video engines listed");

  // 4. #58 & #145 Image Generation
  console.log("\n[4/15] Verifying #58 & #145 Image Generation & Unsupported Provider Error...");
  const invalidProviderRes = await api("/media/images/generate", "POST", {
    prompt: "A beautiful landscape",
    provider: "invalid_fake_provider_xyz",
  });
  assert(invalidProviderRes.status === 400, "Unsupported provider rejected with 400");
  assert(invalidProviderRes.data.error?.code === "UNSUPPORTED_PROVIDER", "Explicit UNSUPPORTED_PROVIDER code returned");

  const genImageRes = await api("/media/images/generate", "POST", {
    prompt: "Futuristic Ukrainian smart city with neon towers",
    provider: "flux",
    size: "1024x1024",
  });
  assert(genImageRes.status === 201, `Image generated: ${genImageRes.status}`, genImageRes.data);
  assert(typeof genImageRes.data.id === "string", `Image ID: ${genImageRes.data.id}`);
  assert(typeof genImageRes.data.imageUrl === "string", `Image URL: ${genImageRes.data.imageUrl}`);

  // 5. #145 Image Editing
  console.log("\n[5/15] Verifying #145 Image Editing (Inpainting)...");
  const editImageRes = await api("/media/images/edit", "POST", {
    baseImageBase64: "dGVzdF9pbWFnZV9kYXRh",
    prompt: "Add autonomous delivery drone",
    operation: "inpaint",
  });
  assert(editImageRes.ok, `Image edited: ${editImageRes.status}`, editImageRes.data);
  assert(editImageRes.data.operationApplied === "inpaint", "Operation applied is inpaint");
  assert(typeof editImageRes.data.editedImageUrl === "string", "Edited image URL returned");

  // 6. #141 Image Understanding
  console.log("\n[6/15] Verifying #141 Image Understanding...");
  const understandRes = await api("/media/images/understand", "POST", {
    imageInput: "https://storage.npati.ai/demo-dashboard.png",
    query: "What analytics charts and metrics are visible?",
  });
  assert(understandRes.ok, `Image understood: ${understandRes.status}`, understandRes.data);
  assert(understandRes.data.detectedObjects?.length > 0, "Objects detected");
  assert(typeof understandRes.data.answers === "string", "Visual reasoning answer generated");

  // 7. #59 OCR Text Extraction
  console.log("\n[7/15] Verifying #59 OCR Text Extraction...");
  const ocrRes = await api("/media/ocr", "POST", {
    content: "NPATI AUTONOMOUS AGENT\nInvoice: INV-2026-9901\nTotal: 4,500.00 EUR\nDue Date: 2026-10-01",
    language: "en-US",
  });
  assert(ocrRes.ok, `OCR text extracted: ${ocrRes.status}`, ocrRes.data);
  assert(ocrRes.data.lines?.length === 4, "4 lines extracted");
  assert(ocrRes.data.confidence > 0.9, "Confidence > 0.9");
  assert(ocrRes.data.fullText?.includes("INV-2026-9901"), "Target invoice token found in text");

  // 8. #142 Document Input/Output
  console.log("\n[8/15] Verifying #142 Document Input/Output (Parse & Generate)...");
  const parseRes = await api("/media/documents/parse", "POST", {
    content: "Product,Price,Quantity\nServer,1200,2\nStorage,400,5",
    filename: "inventory.csv",
    mimeType: "text/csv",
  });
  assert(parseRes.ok, `Document parsed: ${parseRes.status}`, parseRes.data);
  assert(parseRes.data.document?.format === "csv", "Parsed format is CSV");
  assert(parseRes.data.document?.tables?.length === 1, "CSV table structured headers/rows parsed");

  const genDocRes = await api("/media/documents/generate", "POST", {
    data: {
      title: "Quarterly Revenue",
      text: "Summary of Q3 results.",
      table: { headers: ["Quarter", "Revenue"], rows: [["Q3-2026", "$1.2M"]] },
    },
    format: "markdown",
  });
  assert(genDocRes.ok, `Document generated: ${genDocRes.status}`, genDocRes.data);
  assert(genDocRes.data.content?.includes("# Quarterly Revenue"), "Markdown title formatted");
  assert(genDocRes.data.content?.includes("| Q3-2026 | $1.2M |"), "Markdown table formatted");

  // 9. #143 Modality Bridge
  console.log("\n[9/15] Verifying #143 Modality Bridge (Text-only vs Vision Models)...");
  const bridgeRes = await api("/media/bridge", "POST", {
    text: "Analyze this receipt",
    rawImageBuffer: Buffer.from("dummy_receipt_bytes").toString("base64"),
    imageDescriptionOrOcr: "Receipt #402: Total $45.00",
    targetModelCapabilities: { supportsVision: false },
  });
  assert(bridgeRes.ok, `Modality bridged: ${bridgeRes.status}`, bridgeRes.data);
  assert(bridgeRes.data.bridged?.modalityConversionsApplied?.includes("transcoded_image_to_ocr_text"), "Transcoded image to OCR text");
  assert(bridgeRes.data.bridged?.adaptedPrompt?.includes("Receipt #402"), "Prompt enriched with OCR text");

  // 10. #147 Audio Translation
  console.log("\n[10/15] Verifying #147 Audio Translation...");
  const audioRes = await api("/media/audio/translate", "POST", {
    audioBase64: Buffer.from("RIFF_WAV_AUDIO_SAMPLE").toString("base64"),
    sourceLanguage: "uk",
    targetLanguage: "en",
  });
  assert(audioRes.ok, `Audio translated: ${audioRes.status}`, audioRes.data);
  assert(audioRes.data.sourceLanguageDetected === "uk", "Source language detected: uk");
  assert(audioRes.data.targetLanguage === "en", "Target language: en");
  assert(typeof audioRes.data.translatedText === "string", "Translated text generated");

  // 11. #148 Video Understanding
  console.log("\n[11/15] Verifying #148 Video Understanding...");
  const videoAnalysisRes = await api("/media/video/understand", "POST", {
    videoUrl: "https://storage.npati.ai/audit.mp4",
    query: "Is the system online?",
  });
  assert(videoAnalysisRes.ok, `Video analyzed: ${videoAnalysisRes.status}`, videoAnalysisRes.data);
  assert(videoAnalysisRes.data.framesAnalyzed > 0, "Temporal frames analyzed");
  assert(typeof videoAnalysisRes.data.answer === "string", "Answer generated from visual scenes");

  // 12. #235 & #246 Video Generation
  console.log("\n[12/15] Verifying #235 & #246 Video Generation Pipeline...");
  const videoJobRes = await api("/media/video/generate", "POST", {
    prompt: "Aerial view of green hills during sunrise",
    engine: "runway-gen-3",
    durationSeconds: 5,
  });
  assert(videoJobRes.status === 201, `Video job created: ${videoJobRes.status}`, videoJobRes.data);
  assert(videoJobRes.data.job?.status === "completed", "Job status completed");
  assert(videoJobRes.data.job?.videoUrl?.includes(".mp4"), "Video artifact URL returned");

  // 13. #247 Music Generation
  console.log("\n[13/15] Verifying #247 Music Generation...");
  const musicRes = await api("/media/music/generate", "POST", {
    prompt: "Uplifting ambient techno",
    genre: "techno",
    durationSeconds: 60,
    tempoBpm: 128,
  });
  assert(musicRes.status === 201, `Music generated: ${musicRes.status}`, musicRes.data);
  assert(musicRes.data.track?.genre === "techno", "Genre matches");
  assert(musicRes.data.track?.audioUrl?.includes(".mp3"), "Audio artifact URL returned");

  // 14. #248 Realtime Speech & #249 Voice Call & #254 Mobile Voice
  console.log("\n[14/15] Verifying #248 Realtime Speech, #249 Voice Call & #254 Mobile Voice...");
  // Speech session
  const speechStartRes = await api("/media/speech/session/start", "POST", {
    sessionId: `sess_speech_${stamp}`,
  });
  assert(speechStartRes.status === 201, "Speech session started");

  const speechChunkRes = await api("/media/speech/session/chunk", "POST", {
    sessionId: `sess_speech_${stamp}`,
    userIsSpeaking: true,
    transcriptionText: "Привіт агенте",
  });
  assert(speechChunkRes.ok, "Speech chunk processed");
  assert(speechChunkRes.data.chunk?.status === "listening", "VAD listening state confirmed");

  await api("/media/speech/session/end", "POST", { sessionId: `sess_speech_${stamp}` });

  // Voice call
  const dialRes = await api("/media/calls/dial", "POST", {
    toPhoneNumber: "+380501234567",
  });
  assert(dialRes.status === 201, "Outbound call placed");
  const callId = dialRes.data.call?.callId;

  const completeCallRes = await api(`/media/calls/${callId}/complete`, "POST", {
    durationSeconds: 40,
    transcriptSummary: "Питання вирішено успішно.",
  });
  assert(completeCallRes.ok, "Call completed and summary recorded");

  // Mobile voice
  const mobileStartRes = await api("/media/mobile-voice/session/start", "POST", {
    deviceId: `dev_${stamp}`,
    codec: "opus",
  });
  assert(mobileStartRes.status === 201, "Mobile voice session started");

  const mobileFrameRes = await api("/media/mobile-voice/session/frame", "POST", {
    deviceId: `dev_${stamp}`,
    audioFrameBase64: "b3B1c19mcmFtZQ==",
  });
  assert(mobileFrameRes.ok, "Mobile voice audio frame buffered");

  await api("/media/mobile-voice/session/stop", "POST", { deviceId: `dev_${stamp}` });

  // 15. Capability Matrix Live Inspection
  console.log("\n[15/15] Inspecting Live Capability Matrix (/capabilities/inspect)...");
  const inspectRes = await api("/capabilities/inspect");
  assert(inspectRes.ok, "Capability inspection succeeded");
  const p12CapabilityIds = [58, 59, 141, 142, 143, 145, 147, 148, 235, 246, 247, 248, 249, 254];
  const liveItems = inspectRes.data.items || [];
  for (const cid of p12CapabilityIds) {
    const item = liveItems.find((i) => i.id === cid);
    assert(Boolean(item), `Capability #${cid} found in live inspect`);
    assert(item.status === "VERIFIED_EXISTING", `Capability #${cid} status is VERIFIED_EXISTING (got ${item?.status})`);
  }

  console.log("\n==========================================================");
  console.log("  ALL 14 CAPABILITIES IN P1.2 SUCCESSFULLY VERIFIED!     ");
  console.log("==========================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
