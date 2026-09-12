// scripts/verify-production-p11-browser-automation.mjs
// E2E Verification of P1.1 Browser Automation against live Docker container

const BASE_URL = process.env.API_BASE_URL || "http://localhost:3001";
let accessToken = "";

function assert(condition, message, extra = "") {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`, extra);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function login() {
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
  });
  const data = await loginRes.json();
  if (!loginRes.ok || !data.tokens?.accessToken) {
    throw new Error(`Admin login failed: ${JSON.stringify(data)}`);
  }
  accessToken = data.tokens.accessToken;
  console.log("✓ Admin login successful, JWT obtained");
}

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const url = `${BASE_URL}${path}`;
  const hasBody = options.body !== undefined;
  const headers = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${accessToken}`,
    ...(isMutating ? { "idempotency-key": `idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` } : {}),
    ...(options.headers || {}),
  };
  const body = hasBody ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined;

  const res = await fetch(url, {
    ...options,
    headers,
    body,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, data: json };
}

async function run() {
  console.log("==========================================================");
  console.log("  NPATI AGENT — P1.1 BROWSER AUTOMATION E2E TEST (LIVE)");
  console.log("==========================================================\n");

  console.log("[0/11] Authenticating admin user against live container...");
  await login();

  console.log("\n[1/11] Checking Server Health & Auth Guard...");
  const healthRes = await request("/health");
  assert(healthRes.status === 200, "Server is alive and responding");

  const unauthRes = await fetch(`${BASE_URL}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileName: "Unauth" }),
  });
  assert(unauthRes.status === 401, "Unauthenticated request is rejected with 401");

  console.log("\n[2/11] #149 Managed Browser Profile...");
  const createProfileRes = await request("/browser/profiles", {
    method: "POST",
    body: {
      profileName: "E2E Browser Profile",
      userAgent: "NPATI-P11-Automation-Agent/1.0",
      proxyUrl: "http://proxy.internal:8080",
    },
  });
  assert(createProfileRes.status === 201 || createProfileRes.status === 200, "Create profile succeeded");
  const profileId = createProfileRes.data.profile.profileId;
  assert(typeof profileId === "string" && profileId.startsWith("bprof_"), `Profile ID generated: ${profileId}`);

  const getProfileRes = await request(`/browser/profiles/${profileId}`);
  assert(getProfileRes.status === 200, "Get profile succeeded");
  assert(getProfileRes.data.profile.profileName === "E2E Browser Profile", "Profile name matches");

  console.log("\n[3/11] #157 Multi-Profile Browser Manager...");
  const createInstRes = await request("/browser/instances", {
    method: "POST",
    body: {
      profileId,
      incognito: false,
    },
  });
  assert(createInstRes.status === 201 || createInstRes.status === 200, "Create browser instance succeeded");
  const instanceId = createInstRes.data.instance.instanceId;
  assert(typeof instanceId === "string" && instanceId.startsWith("inst_"), `Instance ID generated: ${instanceId}`);

  const listInstRes = await request("/browser/instances");
  assert(listInstRes.status === 200, "List browser instances succeeded");
  assert(listInstRes.data.instances.some((i) => i.instanceId === instanceId), "New instance listed");

  console.log("\n[4/11] #150 Browser Tab Control...");
  const createTabRes = await request("/browser/tabs", {
    method: "POST",
    body: {
      url: "https://npati.example.org/dashboard",
      title: "NPATI Dashboard",
    },
  });
  assert(createTabRes.status === 201 || createTabRes.status === 200, "Create browser tab succeeded");
  const tabId = createTabRes.data.tab.tabId;
  assert(typeof tabId === "string" && tabId.length > 0, `Valid tabId returned: ${tabId}`);

  const listTabsRes = await request("/browser/tabs");
  assert(listTabsRes.status === 200, "List tabs succeeded");
  assert(listTabsRes.data.tabs.some((t) => t.tabId === tabId), "Created tab appears in tabs list");

  const navRes = await request(`/browser/tabs/${tabId}/navigate`, {
    method: "POST",
    body: { url: "https://npati.example.org/settings" },
  });
  assert(navRes.status === 200, "Navigate tab succeeded");
  assert(navRes.data.navigatedTo === "https://npati.example.org/settings", "Tab navigated to new URL");

  const switchRes = await request(`/browser/tabs/${tabId}/switch`, {
    method: "POST",
  });
  assert(switchRes.status === 200, "Switch to tab succeeded", JSON.stringify(switchRes));

  console.log("\n[5/11] SSRF Security Guardrails Enforcement...");
  const ssrfAttempts = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://localhost:5432",
    "http://postgres:5432",
    "http://omniroute:20128/admin",
    "file:///etc/passwd",
  ];
  for (const maliciousUrl of ssrfAttempts) {
    const ssrfRes = await request(`/browser/tabs/${tabId}/navigate`, {
      method: "POST",
      body: { url: maliciousUrl },
    });
    assert(
      ssrfRes.status === 403,
      `Blocked dangerous/SSRF navigation attempt to ${maliciousUrl} (status: ${ssrfRes.status})`
    );
  }

  console.log("\n[6/11] #151 Browser Click/Type Actions & Risk Approval Guard...");
  const typeRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "type",
      selector: "input#search-query",
      text: "NPATI Automated E2E verification test",
    },
  });
  assert(typeRes.status === 200, "Tab type action succeeded");
  assert(typeRes.data.action === "type", "Type action executed");

  const clickRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "click",
      selector: "button#submit-search",
    },
  });
  assert(clickRes.status === 200, "Tab click action succeeded");

  // Test dangerous action requiring approval
  const dangerousRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "click",
      selector: "button#delete-all-workspaces",
    },
  });
  assert(dangerousRes.status === 403, "Destructive action blocked without explicit approval");

  const approvedRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "click",
      selector: "button#delete-all-workspaces",
      approved: true,
    },
  });
  assert(approvedRes.status === 200, "Destructive action succeeds when explicit user approval is passed");

  console.log("\n[7/11] #152 Browser Drag/Select Actions...");
  const dragRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "drag_and_drop",
      selector: ".draggable-item",
      targetSelector: ".drop-target-area",
    },
  });
  assert(dragRes.status === 200, "Tab drag_and_drop action succeeded");

  const selectRes = await request(`/browser/tabs/${tabId}/actions`, {
    method: "POST",
    body: {
      action: "select_option",
      selector: "select#filter-status",
      optionValue: "ACTIVE",
    },
  });
  assert(selectRes.status === 200, "Tab select_option action succeeded");

  console.log("\n[8/11] #153, #154, #155 Visual & DOM Capture (Snapshots, Screenshots, PDFs)...");
  const snapRes = await request(`/browser/tabs/${tabId}/snapshot`);
  assert(snapRes.status === 200, "#153 DOM snapshot succeeded");
  assert(snapRes.data.snapshot.cleanTree.length > 0, "Snapshot includes cleanTree");
  assert(snapRes.data.snapshot.interactiveCount > 0, "Snapshot includes interactive elements");

  const shotRes = await request(`/browser/tabs/${tabId}/screenshot`, {
    method: "POST",
    body: { format: "png", fullPage: true },
  });
  assert(shotRes.status === 200, "#154 Browser screenshot capture succeeded");
  assert(shotRes.data.screenshot.mimeType === "image/png", "Screenshot mimeType is image/png");
  assert(shotRes.data.screenshot.base64Data.length > 0, "Screenshot contains base64 payload");

  const pdfRes = await request(`/browser/tabs/${tabId}/pdf`, {
    method: "POST",
    body: { landscape: false, printBackground: true },
  });
  assert(pdfRes.status === 200, "#155 Browser PDF capture succeeded");
  assert(pdfRes.data.pdf.pageCount >= 1, "PDF page count is at least 1");
  assert(pdfRes.data.pdf.pdfBase64.length > 0, "PDF contains base64 payload");

  console.log("\n[9/11] #156 Browser Downloads & Quarantine Enforcement...");
  const safeDlRes = await request("/browser/downloads", {
    method: "POST",
    body: {
      tabId,
      url: "https://npati.example.org/files/quarterly-report.pdf",
      filename: "quarterly-report.pdf",
      totalBytes: 154200,
    },
  });
  assert(safeDlRes.status === 201 || safeDlRes.status === 200, "Safe file download logged");
  assert(safeDlRes.data.download.status === "completed", "Safe download status is completed");

  const maliciousDlRes = await request("/browser/downloads", {
    method: "POST",
    body: {
      tabId,
      url: "https://malicious.example.org/trojan-installer.exe",
      filename: "trojan-installer.exe",
      totalBytes: 204800,
    },
  });
  assert(maliciousDlRes.status === 403, "Dangerous executable (.exe) was quarantined with 403");
  assert(maliciousDlRes.data.error.code === "DOWNLOAD_QUARANTINED", "Quarantine error code is DOWNLOAD_QUARANTINED");

  const listDlRes = await request("/browser/downloads");
  assert(listDlRes.status === 200, "List downloads succeeded");
  assert(listDlRes.data.downloads.some((d) => d.filename === "quarterly-report.pdf"), "Safe download found in list");

  console.log("\n[10/11] #158 Attach Real Chrome (CDP)...");
  const cdpRes = await request("/browser/cdp/attach", {
    method: "POST",
    body: {
      host: "127.0.0.1",
      port: 9222,
    },
  });
  assert(cdpRes.status === 200, "#158 CDP attach succeeded");
  assert(cdpRes.data.attachment.connected === true, "CDP session connected");

  // Cleanup tab, instance, and profile
  const delTabRes = await request(`/browser/tabs/${tabId}`, { method: "DELETE" });
  assert(delTabRes.status === 200, "Closed browser tab successfully");

  const delInstRes = await request(`/browser/instances/${instanceId}`, { method: "DELETE" });
  assert(delInstRes.status === 200, "Terminated browser instance successfully");

  const delProfRes = await request(`/browser/profiles/${profileId}`, { method: "DELETE" });
  assert(delProfRes.status === 200, "Deleted browser profile successfully");

  console.log("\n[11/11] Verifying Capability Matrix on Server (/capabilities/inspect)...");
  const capsRes = await request("/capabilities/inspect");
  assert(capsRes.status === 200, "Capabilities inspect endpoint returned 200");
  const caps = capsRes.data.items || capsRes.data.capabilities || [];
  const p11Ids = [149, 150, 151, 152, 153, 154, 155, 156, 157, 158];
  for (const id of p11Ids) {
    const item = caps.find((c) => c.id === id);
    assert(item !== undefined, `Capability #${id} exists in live capability inspection`);
    assert(
      item.status === "VERIFIED_EXISTING",
      `Capability #${id} (${item.capabilityId}) is VERIFIED_EXISTING in live runtime`
    );
  }

  console.log("\n==========================================================");
  console.log("  ALL 10 BROWSER AUTOMATION CAPABILITIES VERIFIED IN DOCKER!");
  console.log("==========================================================\n");
}

run().catch((err) => {
  console.error("FATAL ERROR during E2E verification:", err);
  process.exit(1);
});
