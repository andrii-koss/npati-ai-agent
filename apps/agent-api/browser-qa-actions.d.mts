import type { BrowserQaAction, BrowserQaInteraction } from "@npati/workspace";
export type { BrowserQaAction, BrowserQaObservation, BrowserQaInteraction } from "@npati/workspace";
export const BROWSER_QA_KEYS: string[];
export function assertBrowserQaActions(actions:unknown):void;
export function runBrowserQaActions(page:unknown,actions?:BrowserQaAction[]):Promise<BrowserQaInteraction[]>;
