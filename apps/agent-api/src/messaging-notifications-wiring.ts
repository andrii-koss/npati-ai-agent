
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { connectionWantsNotification } from "./code-background-run-notifications";
import { MessagingGateway } from "./messaging-gateway";
import { MessagingIntegrationsRepository } from "./messaging-integrations-repository";

export interface CreateMessagingNotificationsWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  messagingGateway: MessagingGateway;
  messagingIntegrationsRepo: MessagingIntegrationsRepository;
}

export function createMessagingNotificationsWiring(deps: CreateMessagingNotificationsWiringDeps) {
  const { config, log, messagingGateway, messagingIntegrationsRepo } = deps;
  const notifyMessagingConnections = async (input: {
    workspaceId: string;
    userId: string;
    companyId: string;
    agentId?: string | null;
    kind: "automation" | "background_run" | "approval";
    title: string;
    detail: string;
  }) => {
    const connections = await messagingIntegrationsRepo.listConnectedForCompany(
      input.workspaceId, input.userId, input.companyId, input.agentId ?? undefined,
    );
    const wanted = (connection: (typeof connections)[number]): boolean =>
      connectionWantsNotification(input.kind, connection.settings);
    await Promise.allSettled(connections.filter(wanted).map(async (connection) => {
      const notificationTarget = connection.channel === "whatsapp"
        ? (connection.settings.access.allowedUserIds[0] || connection.externalChatId)
        : connection.externalChatId;
      if (!notificationTarget) return;
      try {
        await messagingGateway.adapter(connection.channel).sendText(
          messagingIntegrationsRepo.resolveToken(connection), notificationTarget,
          `${input.title}\n\n${input.detail}`, connection.externalThreadId || undefined,
        );
        await messagingIntegrationsRepo.record(connection.id, "outbound");
      } catch (error) {
        await messagingIntegrationsRepo.record(connection.id, "outbound", error instanceof Error ? error.message : String(error));
      }
    }));
  };

  return {
    notifyMessagingConnections,
  };
}
