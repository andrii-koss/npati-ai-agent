import { ReactNode, createContext } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "./business-workspace-shared";
import { Message } from "./business-workspace-cards";
export const ChatContextSwitcherContext = createContext<ReactNode>(null);
export function BusinessSwitcher() {
    const { overview, loading, switchBusiness } = useWorkspace();
    if (loading)
        return null;
    if (!overview?.businesses.length)
        return <Link className="business-switcher setup" to="/business">Set up business</Link>;
    return (<label className="business-switcher">
      <span>Current business</span>
      <select value={overview.currentBusiness?.id ?? ""} onChange={(event) => void switchBusiness(event.target.value)}>
        {overview.businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
      </select>
    </label>);
}
export function expandDeleteConfirmationReply(message: string, history: Message[]): string {
    if (!/^(?:так|так,|підтверджую|да|да,|подтверждаю|yes|yes,|confirm)$/iu.test(message.trim()))
        return message;
    const previous = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
    const command = /(?:Для підтвердження напишіть|Для подтверждения напишите|To confirm, write):\s*\*\*([^*]+)\*\*/iu.exec(previous)?.[1]?.trim();
    return command || message;
}
export function isWebsiteAnalysisRequest(message: string) {
    return /https?:\/\/|www\.|\b(?:website|webpage|site|scan|crawl)\b|сайт|вебсторінк|проскануй/iu.test(message);
}
