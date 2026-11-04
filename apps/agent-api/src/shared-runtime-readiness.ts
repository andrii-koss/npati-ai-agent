/** The cache belongs to this runner process, never to an API client or project. */
export function createSharedRuntimeReadiness(checks: {
  isolation: () => Promise<string | null>;
  proxy: () => Promise<boolean>;
  network: () => Promise<boolean>;
}, now: () => number = Date.now) {
  let generation = 0;
  let isolation: { value: string; expires: number } | undefined;
  let pending: Promise<{ isolation: string | null; proxy: boolean; network: boolean }> | undefined;
  function invalidate() { generation++; isolation = undefined; pending = undefined; }
  function check(): Promise<{ isolation: string | null; proxy: boolean; network: boolean }> {
    if (pending) return pending;
    const current = generation;
    const probe = isolation && now() < isolation.expires
      ? Promise.resolve(isolation.value)
      : checks.isolation().catch(() => null).then(value => {
        if (value && current === generation) isolation = { value, expires: now() + 2000 };
        return value;
      });
    const work: Promise<{ isolation: string | null; proxy: boolean; network: boolean }> = Promise.all([probe, checks.proxy().catch(() => false), checks.network().catch(() => false)])
      .then(([value, proxy, network]) => {
        // A failed command/check invalidates a probe already in flight, so its answer says nothing either way.
        // Ask again: any failed preview request used to read as "the whole runtime is not ready".
        if (current !== generation) return check();
        if (!value || !proxy || !network) invalidate();
        return { isolation: value, proxy, network };
      });
    pending = work;
    void work.finally(() => { if (pending === work) pending = undefined; });
    return work;
  }
  return { check, invalidate };
}
