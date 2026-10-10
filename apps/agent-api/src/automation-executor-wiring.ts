/* The automation executor of app.ts, extracted in step 2c-6c of
 * docs/refactoring/PLAN.md. Moved verbatim inside a factory that returns it.
 */
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { AuthContext, AuthContext as _AuthContext } from "@npati/workspace";
import { resolveAutomationAllowedPermissions, serviceIdentityForAutomation } from "./code-service-identity";
import { CompanyDelegationRuntime } from "./company-runtime";
import { createCoreServices } from "./core-services";
import { EmailInboxRepository } from "./email-inbox-repository";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";

export interface CreateAutomationExecutorDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  automationAllowedPermissions: ReturnType<typeof resolveAutomationAllowedPermissions>;
  browserCredentials: BrowserCredentialsRepository | undefined;
  companyRuntime: CompanyDelegationRuntime;
  emailInboxRepo: EmailInboxRepository;
}

export function createAutomationExecutor(deps: CreateAutomationExecutorDeps) {
  const { log, agent, automationAllowedPermissions, browserCredentials, companyRuntime, emailInboxRepo } = deps;
  const executeAutomation = async (automation: import("./automations-repository").CompanyAutomation, executionKey: string) => {
    /**
     * C5a (owner decision): the unattended run executes as a **service identity** whose permissions are the
     * reviewed inventory in `code-service-identity.ts`, instead of the owner with a fixed wide permission
     * set. The owner id stays in the context because NPATI resolves companies by `user_id`
     * (`assertCompany`), while `externalSubject` carries `service:automation:<id>` — so the principal is a
     * service wherever it matters: it can never approve anything and can never reach production.
     */
    const automationIdentity = serviceIdentityForAutomation({
      companyId: automation.companyId,
      automationId: automation.id,
      workspaceId: automation.workspaceId,
      ownerUserId: automation.userId,
      allowedPermissions: automationAllowedPermissions.allowed,
    });
    const automationContext: AuthContext = automationIdentity.auth;
    const configuredTargets = browserCredentials
      ? (await browserCredentials.listTargets(automationContext, automation.companyId)).filter((target) => target.automationId === automation.id)
      : [];
    if (browserCredentials && configuredTargets.length) {
      const claimed = await browserCredentials.claimTargets(automationContext, automation.companyId, automation.id, 10);
      if (!claimed.length) return { result: "No pending browser campaign sites. Up to 10 sites are processed per scheduled run." };
      const results: string[] = [];
      for (const target of claimed) {
        try {
          if (!target.emailAccountId) throw new Error("A Company email account must be selected for this site");
          const emailAccount = await emailInboxRepo.getAccount(automationContext, automation.companyId, target.emailAccountId);
          if (!emailAccount) throw new Error("The selected Company email account is no longer available");
          const credentialId = await browserCredentials.ensureTargetCredential(automationContext, automation.companyId, target, emailAccount.emailAddress);
          const targetTask = [
            automation.prompt,
            `Process exactly one approved browser campaign site: ${target.siteName}.`,
            `Registration URL: ${target.registrationUrl}`,
            target.publishUrl ? `Article publishing URL: ${target.publishUrl}` : "",
            `Allowed domain: ${target.allowedDomain}`,
            `Company email: ${emailAccount.emailAddress}`,
            target.articleTitle ? `Article title: ${target.articleTitle}` : "",
            target.articleBody ? `Article body:\n${target.articleBody}` : "",
            `Use browser.browser_clicktype with operation \"task\", url \"${target.registrationUrl}\", allowedDomains [\"${target.allowedDomain}\"], campaignTargetId \"${target.id}\", emailHint \"${target.allowedDomain}\", and credentialRefs [{\"id\":\"${credentialId}\",\"alias\":\"account\"}].`,
            "Register if necessary, complete email verification when requested, publish the article when a publishing URL is present, and return the final public URL. Never claim success without browser evidence.",
          ].filter(Boolean).join("\n\n");
          const details = await companyRuntime.execute(
            automationContext,
            automation.companyId,
            { task: targetTask, mode: automation.agentId ? "single" : "auto" },
            `${executionKey}:target:${target.id}:attempt:${target.attempts}`,
          );
          const refreshed = await browserCredentials.getTarget(automationContext, automation.companyId, target.id);
          if (details.run.status !== "completed") {
            await browserCredentials.recordTargetResult(automationContext, automation.companyId, target.id, {
              status: "failed", runId: details.run.id, errorMessage: details.run.errorMessage || `Company run ended with ${details.run.status}`,
            });
            results.push(`${target.siteName}: failed`);
          } else if (!refreshed || refreshed.status === "processing") {
            await browserCredentials.recordTargetResult(automationContext, automation.companyId, target.id, {
              status: "failed", runId: details.run.id, errorMessage: "Agent finished without a verified browser result",
            });
            results.push(`${target.siteName}: failed (no verified browser result)`);
          } else {
            results.push(`${target.siteName}: ${refreshed.status}${refreshed.resultUrl ? ` — ${refreshed.resultUrl}` : ""}`);
          }
        } catch (error) {
          await browserCredentials.recordTargetResult(automationContext, automation.companyId, target.id, {
            status: "failed", errorMessage: error instanceof Error ? error.message : String(error),
          });
          results.push(`${target.siteName}: failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { result: `Browser campaign processed ${claimed.length} site(s):\n${results.join("\n")}` };
    }
    const task = [
      automation.prompt,
      automation.agentId ? `Assigned automation agent: ${automation.agentId}.` : "",
      "This is an unattended scheduled Company automation. Use the linked Business profile, Company Knowledge, and approved browser credential references. Report concrete completed actions and resulting public URLs; never report success without verified browser evidence.",
    ].filter(Boolean).join("\n\n");
    const details = await companyRuntime.execute(
      automationContext,
      automation.companyId,
      { task, mode: automation.agentId ? "single" : "auto" },
      executionKey,
    );
    if (details.run.status !== "completed") {
      throw new Error(details.run.errorMessage || `Company automation run ended with status ${details.run.status}`);
    }
    return { result: details.run.result || `Company run ${details.run.id} completed.` };
  };

  return { executeAutomation };
}
