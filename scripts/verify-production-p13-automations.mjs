// scripts/verify-production-p13-automations.mjs
// E2E Verification of P1.3 Automations, Triggers & Durable Tasks against live Docker runtime

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const stamp = Date.now();
let companyId = "";

console.log("==========================================================");
console.log("  NPATI AGENT — P1.3 AUTOMATIONS & DURABLE TASKS LIVE E2E ");
console.log("==========================================================");

function assert(condition, message, extra = "") {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`, extra);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  // 1. Initial login
  console.log("\n[0/12] Authenticating admin user against live container...");
  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.tokens?.accessToken) {
    throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
  }
  const token = login.tokens.accessToken;
  console.log("✓ Admin login successful, JWT obtained");

  async function api(path, method = "GET", body = undefined, customHeaders = {}) {
    const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    const headers = {
      authorization: `Bearer ${token}`,
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

  // Create test company
  console.log("\n[0.5/12] Creating isolated test company...");
  const companyRes = await api("/companies", "POST", { name: `Automations E2E ${stamp}` });
  assert(companyRes.ok, "Company created successfully", companyRes.data);
  const companyObj = companyRes.data?.value || companyRes.data?.company || companyRes.data;
  companyId = companyObj.id;
  assert(Boolean(companyId), `Company ID obtained: ${companyId}`);

  try {
    // 2. Auth Guard check
    console.log("\n[1/12] Checking Auth Guards on Automations routes...");
    const unauthRes = await fetch(`${base}/companies/${companyId}/automations`);
    assert(unauthRes.status === 401, "Unauthenticated access to automations rejected with 401");

    // 3. #128 Webhooks Registration & Ingress (#135)
    console.log("\n[2/12] Verifying #128 system.webhooks & #135 system.webhooks_ingress...");
    const webhookRes = await api(`/companies/${companyId}/webhooks`, "POST", {
      name: "E2E Production Webhook",
      promptTemplate: "Process incoming webhook event payload: {{payload}}",
    });
    assert(webhookRes.ok, `Webhook registered: ${webhookRes.status}`, webhookRes.data);
    const webhook = webhookRes.data?.webhook || webhookRes.data;
    const webhookId = webhook.id;
    const webhookSecret = webhook.secret;
    assert(typeof webhookId === "string", `Webhook ID returned: ${webhookId}`);
    assert(typeof webhookSecret === "string", `Webhook Secret generated: ${webhookSecret}`);

    // Public Ingress endpoint
    const ingressRes = await fetch(`${base}/api/v1/webhooks/${webhookSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "task.completed", taskId: "task-live-1", status: "success" }),
    });
    const ingressJson = await ingressRes.json();
    assert(ingressRes.status === 202, `Webhook ingress accepted: ${ingressRes.status}`, ingressJson);
    assert(ingressJson.status === "accepted", "Ingress response status is accepted");
    assert(ingressJson.webhookId === webhookId, "Ingress response references correct webhookId");

    // 4. #129 Automations Scheduler & #130 Cron Jobs
    console.log("\n[3/12] Verifying #129 system.automations_scheduler & #130 system.cron_jobs...");
    const createAutoRes = await api(`/companies/${companyId}/automations`, "POST", {
      name: "Daily Health Check Cron",
      cronExpression: "0 9 * * *",
      prompt: "Run daily system health check",
    });
    assert(createAutoRes.ok, `Automation created: ${createAutoRes.status}`, createAutoRes.data);
    const automationId = createAutoRes.data?.id || createAutoRes.data?.automation?.id;
    assert(typeof automationId === "string", `Automation ID returned: ${automationId}`);

    const listAutoRes = await api(`/companies/${companyId}/automations`);
    assert(listAutoRes.ok, "List automations succeeded");
    assert(Array.isArray(listAutoRes.data.automations), "Automations list is an array");
    const foundAuto = listAutoRes.data.automations.find((a) => a.id === automationId);
    assert(Boolean(foundAuto), "Created automation found in list");

    // 5. #131 Background Tasks Ledger
    console.log("\n[4/12] Verifying #131 system.background_tasks_ledger...");
    const runRes = await api(`/companies/${companyId}/automations/${automationId}/run`, "POST", {});
    assert(runRes.ok, `Automation manual trigger succeeded: ${runRes.status}`, runRes.data);
    assert(runRes.data.status === "completed", "Run completed successfully");
    const runId = runRes.data.runId;
    assert(typeof runId === "string", `Run ID returned: ${runId}`);

    const runsListRes = await api(`/companies/${companyId}/automations/${automationId}/runs`);
    assert(runsListRes.ok, "List automation runs succeeded", runsListRes.data);
    assert(Array.isArray(runsListRes.data.runs), "Runs list is an array");
    const foundRun = runsListRes.data.runs.find((r) => r.id === runId);
    assert(Boolean(foundRun), "Execution run recorded and found in background ledger");

    // 6. #133 Task Flow Engine
    console.log("\n[5/12] Verifying #133 system.task_flow...");
    const flowId = `flow_onboard_${stamp}`;
    const flowRes = await api(`/companies/${companyId}/flows`, "POST", {
      id: flowId,
      name: "Customer Onboarding Flow",
      entryStepId: "step_verify",
      steps: [
        { id: "step_verify", name: "Verify Identity", type: "action", nextStepId: "step_notify" },
        { id: "step_notify", name: "Send Welcome Email", type: "action" },
      ],
    });
    assert(flowRes.ok, `Task Flow created: ${flowRes.status}`, flowRes.data);
    assert(flowRes.data.flow?.id === flowId, `Flow registered with ID: ${flowId}`);

    const execFlowRes = await api(`/companies/${companyId}/flows/${flowId}/run`, "POST", {
      initialContext: { userId: "user-999" },
    });
    assert(execFlowRes.ok, `Task Flow executed: ${execFlowRes.status}`, execFlowRes.data);
    assert(execFlowRes.data.execution?.status === "completed", "Flow completed all steps successfully");
    assert(execFlowRes.data.execution?.executionPath?.includes("step_verify"), "Step 1 completed in execution path");
    assert(execFlowRes.data.execution?.executionPath?.includes("step_notify"), "Step 2 completed in execution path");

    // 7. #134 Standing Orders Manager
    console.log("\n[6/12] Verifying #134 system.standing_orders...");
    const orderId = `so_balance_${stamp}`;
    const orderRes = await api(`/companies/${companyId}/standing-orders`, "POST", {
      id: orderId,
      title: "Low Balance Standing Order",
      conditionField: "balanceUsd",
      thresholdValue: 20,
    });
    assert(orderRes.ok, `Standing order created: ${orderRes.status}`, orderRes.data);
    assert(orderRes.data.order?.id === orderId, `Standing order ID matches: ${orderId}`);

    const evalRes = await api(`/companies/${companyId}/standing-orders/evaluate`, "POST", {
      eventData: { balanceUsd: 12 },
    });
    assert(evalRes.ok, `Standing orders evaluated: ${evalRes.status}`, evalRes.data);
    const triggered = evalRes.data.evaluations?.find((e) => e.orderId === orderId);
    assert(Boolean(triggered && triggered.triggered), "Standing order condition triggered when balance < 20");

    // 8. #136 IMAP Email Trigger
    console.log("\n[7/12] Verifying #136 communications.imap_email_trigger...");
    const emailRes = await api(`/companies/${companyId}/inbound-email`, "POST", {
      from: "partner@example.com",
      to: `agent@${companyId}.npati.ai`,
      subject: "Quarterly Audit Report",
      body: "Please review the attached quarterly revenue report.",
    });
    assert(emailRes.ok, `Inbound email processed: ${emailRes.status}`, emailRes.data);
    assert(typeof (emailRes.data.task?.taskPrompt || emailRes.data.task?.prompt) === "string", "Task prompt generated from email");

    // 9. #137 Webhook Retries & DLQ
    console.log("\n[8/12] Verifying #137 system.webhook_retries & Dead Letter Queue...");
    const dispatchFailRes = await api(`/companies/${companyId}/webhooks/dispatch`, "POST", {
      url: "https://invalid-non-existent-domain-xyz999.internal/webhook",
      eventType: "order.created",
      data: { orderId: "ord-404" },
      maxRetries: 2,
      simulateFailure: true,
    });
    assert(dispatchFailRes.ok, `Webhook dispatch handled: ${dispatchFailRes.status}`, dispatchFailRes.data);
    assert(dispatchFailRes.data.result?.success === false, "Dispatch reported failure as expected");
    assert(dispatchFailRes.data.result?.attempts === 2, "Dispatch retried specified maxRetries times");

    // 10. #138 One-Shot Reminders
    console.log("\n[9/12] Verifying #138 system.one-shot_reminders...");
    const remindRes = await api(`/companies/${companyId}/reminders`, "POST", {
      recipientId: "user-e2e-123",
      title: "Standup meeting in 15 minutes",
      targetAt: new Date(Date.now() - 5000).toISOString(),
    });
    assert(remindRes.ok, `One-shot reminder scheduled: ${remindRes.status}`, remindRes.data);
    const reminderId = remindRes.data.reminder?.id;
    assert(typeof reminderId === "string", `Reminder ID returned: ${reminderId}`);

    const dueRemindRes = await api(`/companies/${companyId}/reminders/due`);
    assert(dueRemindRes.ok, `Due reminders checked: ${dueRemindRes.status}`, dueRemindRes.data);
    const foundReminder = dueRemindRes.data.dueReminders?.find((r) => r.id === reminderId);
    assert(Boolean(foundReminder), "Due reminder found in due queue");

    // 11. #140 Agent Lifecycle Hooks
    console.log("\n[10/12] Verifying #140 system.lifecycle_hooks...");
    const hookRes = await api(`/companies/${companyId}/lifecycle-hooks`, "POST", {
      hookName: "before_agent_run",
      priority: 10,
    });
    assert(hookRes.ok, `Lifecycle hook registered: ${hookRes.status}`, hookRes.data);

    const emitRes = await api(`/companies/${companyId}/lifecycle-hooks/emit`, "POST", {
      hookName: "before_agent_run",
      context: { task: "deploy" },
    });
    assert(emitRes.ok, `Lifecycle hooks emitted: ${emitRes.status}`, emitRes.data);
    assert(emitRes.data.emitted === true, "Lifecycle hook emitted successfully");

    // 12. Capability Matrix live inspection
    console.log("\n[11/12] Inspecting Live Capability Matrix (/capabilities/inspect)...");
    const inspectRes = await api("/capabilities/inspect");
    assert(inspectRes.ok, "Capability inspection succeeded");
    const p13CapabilityIds = [128, 129, 130, 131, 133, 134, 135, 136, 137, 138, 140];
    const liveItems = inspectRes.data.items || [];
    for (const cid of p13CapabilityIds) {
      const item = liveItems.find((i) => i.id === cid);
      assert(Boolean(item), `Capability #${cid} found in live inspect`);
      assert(item.status === "VERIFIED_EXISTING", `Capability #${cid} status is VERIFIED_EXISTING (got ${item?.status})`);
    }

    console.log("\n==========================================================");
    console.log("  ALL 11 CAPABILITIES IN P1.3 SUCCESSFULLY VERIFIED!     ");
    console.log("==========================================================");
  } finally {
    if (companyId) {
      console.log(`\nCleaning up test company ${companyId}...`);
      await api(`/companies/${companyId}`, "DELETE").catch(() => undefined);
      console.log("✓ Cleanup complete");
    }
  }
}

run().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
