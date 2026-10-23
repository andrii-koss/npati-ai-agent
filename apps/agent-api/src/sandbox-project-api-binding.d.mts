export interface ProjectApiBindingRequest {
  method: string; path: string; headers: Record<string, string>; bodyBase64: string;
}
export interface ProjectApiBindingResponse {
  status: number; headers: Record<string, string>; bodyBase64: string;
}
export const PROJECT_API_SERVICE_HOST: string;
export const PROJECT_API_RESPONSE_HEADERS: string[];
export const PROJECT_API_BODY_LIMIT: number;
export const PROJECT_API_RESPONSE_LIMIT: number;
export function validProjectApiRequest(value: unknown): value is ProjectApiBindingRequest;
export function validProjectApiResponse(value: unknown): value is ProjectApiBindingResponse;
export function dispatchProjectApiRequest(value: ProjectApiBindingRequest): Promise<ProjectApiBindingResponse>;
export function createProjectApiServiceBinding(mode?: string, options?: {
  dispatch?: (value: ProjectApiBindingRequest) => Promise<ProjectApiBindingResponse>;
}): { matches(url: URL): boolean; handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url?: URL): Promise<void>;
  connect(req: import("node:http").IncomingMessage, client: import("node:net").Socket, head: Buffer): boolean } | undefined;
