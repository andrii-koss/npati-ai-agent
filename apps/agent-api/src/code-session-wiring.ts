
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
