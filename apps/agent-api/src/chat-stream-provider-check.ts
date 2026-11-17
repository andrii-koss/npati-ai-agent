import type { ChatStreamRouteDeps } from "./chat-stream-route-types";
import type { AuthContext } from "@npati/workspace";
import type { FastifyBaseLogger } from "fastify";
/** Preserve the preferences fallback when marketplace discovery is unavailable. */
export async function chatHasConnectedProvider(deps: ChatStreamRouteDeps, auth: AuthContext, log: FastifyBaseLogger) {
    const { marketplace, aiPreferences } = deps;
    let hasConnectedProviders = true;
    try {
        const connected = await marketplace.marketplace({ tab: "connected", limit: 1 });
        hasConnectedProviders = connected.overview.connectedProviders > 0;
    }
    catch (err) {
        log.warn({ err }, "Marketplace check failed, checking AI preferences fallback");
        const prefs = await aiPreferences.get(auth).catch(() => null);
        hasConnectedProviders = Boolean(prefs?.addedModels?.length);
    }
    return hasConnectedProviders;
}
