/**
 * Evidence for the report: is the third failure of
 * `tests/coding-agent-c5a-rbac-foundation.test.ts` caused by the role-name alignment, or was it already
 * failing with the old matrix?
 *
 * It reproduces the suite's assertion ("denies a plain member where an owner is required") against a
 * matrix that still defines `member` exactly as the old default did. If the call resolves (allowed), the
 * assertion was already unsatisfiable before this step — i.e. a pre-existing defect in that suite, not a
 * regression from removing the placeholder role.
 */
import { authorizeCodeAction, createRoleRegistry } from "../../apps/agent-api/src/code-rbac";
import type { AuthContext } from "@npati/workspace";

const OLD_MEMBER_MATRIX = { roles: { member: ["workspace:read", "workspace:write", "tools:read"] } };
const audit = { record: async () => {} };

function principal(): AuthContext {
  return {
    workspaceId: "ws-rbac",
    userId: "user-rbac",
    companyId: "company-rbac",
    permissions: ["workspace:read"],
    role: "member",
  } as unknown as AuthContext;
}

for (const permission of ["business:manage", "workspace:read"]) {
  const outcome = await authorizeCodeAction(
    principal(),
    "company-rbac",
    { permission, action: "code.flags.change" },
    { registry: createRoleRegistry(OLD_MEMBER_MATRIX), audit },
  ).then(
    () => "ALLOWED (the suite's `rejects` expectation cannot hold)",
    (error: { code?: string }) => `denied:${error.code}`,
  );
  console.log(`with the OLD matrix, permission=${permission} -> ${outcome}`);
}
