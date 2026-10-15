import { useState } from "react";
import { getChannelIcon } from "../integration-icons";
import { Channel, initial } from "./types";

export function ChannelIcon({ channel, size }: { channel: Channel; size?: "small" | "large" }) {
  const icon = getChannelIcon(channel.id);
  const [failed, setFailed] = useState(false);
  return (
    <span className={`provider-avatar${size ? ` ${size}` : ""}`} aria-hidden="true">
      <span className="provider-initials">{initial(channel.name)}</span>
      {icon && !failed && (
        <img src={icon} alt="" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ai-badge ${tone}`}>{children}</span>;
}

export function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={`integration-toggle${disabled ? " disabled" : ""}`}>
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}
