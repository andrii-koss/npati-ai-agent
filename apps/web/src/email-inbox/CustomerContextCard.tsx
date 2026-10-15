import type { ContactDetails, CustomerContext, EmailThread } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface CustomerContextCardProps {
  activeThread: EmailThread;
  contact: ContactDetails | null;
  customerContext: CustomerContext;
  customerCardExpanded: boolean;
  onToggleCustomerCardExpanded: () => void;
  language: string;
}

export function CustomerContextCard({
  activeThread,
  contact,
  customerContext,
  customerCardExpanded,
  onToggleCustomerCardExpanded,
  language,
}: CustomerContextCardProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Customer Context Card */}
      <section className="email-customer-card">
        <div
          className="email-customer-card-header"
          onClick={onToggleCustomerCardExpanded}
        >
          <div className="email-customer-title-group">
            <span>
              {t("emailInbox.customerProfile.profileHeading")
                .replace("{name}", contact?.name || activeThread.customerName || t("emailInbox.customerProfile.customerDefault"))
                .replace("{email}", activeThread.customerEmail)}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="email-customer-stats-pills">
              <span>
                <strong>{contact?.previousThreadsCount ?? customerContext.previousThreads.length}</strong> {t("emailInbox.customerProfile.previousThreadsCount")}
              </span>
              <span>
                <strong>{customerContext.tasks.length}</strong> {t("emailInbox.customerProfile.tasksCount")}
              </span>
              <span>
                <strong>{contact?.lastActivityAt ? new Date(contact.lastActivityAt).toLocaleDateString(language) : t("emailInbox.customerProfile.active")}</strong>
              </span>
            </div>
            <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>
              {customerCardExpanded ? t("emailInbox.customerProfile.hide") : t("emailInbox.customerProfile.details")}
            </span>
          </div>
        </div>

        {customerCardExpanded && (
          <div className="email-customer-card-body">
            {contact?.companyName && (
              <span style={{ fontSize: 12, color: "#475569" }}>
                {t("emailInbox.customerProfile.companyPrefix")}{contact.companyName}
              </span>
            )}
            {contact?.phone && (
              <span style={{ fontSize: 12, color: "#475569" }}>
                {t("emailInbox.customerProfile.phonePrefix")}{contact.phone}
              </span>
            )}
            {contact?.notes && (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#334155" }}>
                {t("emailInbox.customerProfile.notesPrefix")}{contact.notes}
              </p>
            )}

            {(customerContext.previousThreads.length > 0 || customerContext.tasks.length > 0) && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                  {t("emailInbox.customerProfile.interactionsSummary")}
                </summary>
                <div style={{ display: "grid", gap: 5, marginTop: 7, fontSize: 11.5, color: "#475569" }}>
                  {customerContext.previousThreads.map((item) => (
                    <span key={item.id}>
                      {t("emailInbox.customerProfile.emailPrefix")} · {item.subject} · {item.status} · {item.priority}
                    </span>
                  ))}
                  {customerContext.tasks.map((item) => (
                    <span key={item.id}>
                      {t("emailInbox.customerProfile.taskPrefix")} · {item.task.slice(0, 120)} · {item.status}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Collision Protection Warning */}
      {activeThread.lockedByUserId && (
        <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 12 }}>
          {t("emailInbox.threadDetail.collisionWarning")}
        </div>
      )}
    </>
  );
}
