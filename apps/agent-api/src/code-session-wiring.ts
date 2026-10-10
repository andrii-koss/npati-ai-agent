/* The code session modes and membership contexts of app.ts, extracted in step 2c-6h of
 * docs/refactoring/PLAN.md. Moved verbatim inside a factory that returns it.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { AuthContext } from "@npati/workspace";

export interface CreateCodeSessionWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
}

export function createCodeSessionWiring(deps: CreateCodeSessionWiringDeps) {
  const { config, log } = deps;
  const codeMembershipContexts = new WeakMap<object, AuthContext>();

  return {
    codeMembershipContexts,
  };
}
