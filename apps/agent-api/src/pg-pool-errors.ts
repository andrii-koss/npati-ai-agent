import pg from "pg";

/**
 * A pool with no "error" listener throws when an idle connection breaks, and that killed the whole process each time
 * Postgres restarted. Queries already fail on their own, and the pool replaces the broken connection on the next one.
 */
export function keepPoolErrorsFromCrashing(pool: typeof pg.Pool = pg.Pool, warn: (message: string) => void = console.warn): void {
  const emit = pool.prototype.emit;
  pool.prototype.emit = function emitWithoutCrashing(this: pg.Pool, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) {
      warn(`postgres_idle_connection_lost: ${args[0] instanceof Error ? args[0].message : String(args[0])}`);
      return true;
    }
    return emit.call(this, event, ...args);
  } as typeof emit;
}
