/**
 * This release imposes no platform usage quotas, in any environment.
 * Legacy algorithms/configuration remain for a future policy change, but neither
 * environment variables nor persisted counters can enable enforcement today.
 * Permissions, approvals, concurrent leases, timeouts and loop guards are separate.
 */
export function usageQuotasEnabled(): boolean {
  return false;
}
