export class WorkspaceAccessError extends Error {
  // Declared as `number`/`string` rather than as literals so a more specific refusal can extend this
  // class (see `CompanyMembershipError`) and still be caught by every existing route mapper that tests
  // `instanceof WorkspaceAccessError`, while reporting its own code and status. The runtime defaults are
  // unchanged.
  readonly status: number = 403;
  readonly code: string = "BUSINESS_ACCESS_DENIED";
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";
}

