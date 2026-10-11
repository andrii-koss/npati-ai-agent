
export const messageCols = `
  id, workspace_id AS "workspaceId", company_id AS "companyId",
  thread_id AS "threadId", email_account_id AS "emailAccountId", message_id AS "messageId",
  in_reply_to AS "inReplyTo", direction, from_address AS "fromAddress",
  from_name AS "fromName", to_addresses AS "toAddresses", cc_addresses AS "ccAddresses",
  bcc_addresses AS "bccAddresses", subject, body_text AS "bodyText", body_html AS "bodyHtml",
  attachments, delivery_status AS "deliveryStatus", delivery_error AS "deliveryError",
  is_draft AS "isDraft", is_ai_generated AS "isAiGenerated",
  ai_draft_approved_by AS "aiDraftApprovedBy", sent_by_user_id AS "sentByUserId",
  sent_by_agent_id AS "sentByAgentId", created_at AS "createdAt"
`;

export function extractCandidateMessageIds(headerValue?: string | null): string[] {
  if (!headerValue || typeof headerValue !== "string") return [];
  const candidates = new Set<string>();
  const trimmed = headerValue.trim();
  if (!trimmed) return [];

  const bracketMatches = trimmed.match(/<([^>]+)>/g);
  if (bracketMatches) {
    for (const match of bracketMatches) {
      candidates.add(match);
      const inside = match.replace(/[<>]/g, "").trim();
      if (inside) {
        candidates.add(inside);
        const localPart = inside.split("@")[0]?.trim();
        if (localPart) candidates.add(localPart);
      }
    }
  }

  for (const part of trimmed.split(/[\s,]+/)) {
    const clean = part.replace(/[<>]/g, "").trim();
    if (clean) {
      candidates.add(clean);
      candidates.add(`<${clean}>`);
      const localPart = clean.split("@")[0]?.trim();
      if (localPart) candidates.add(localPart);
    }
  }

  return Array.from(candidates);
}

