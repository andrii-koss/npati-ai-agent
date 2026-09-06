export interface SkillContext {
  userMessage: string;
  businessStage?: string;
}

export interface SkillResult {
  message: string;
  suggestedActions: string[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  inputSchema: Record<string, unknown>;
  purpose?: string;
  triggers?: Array<string | RegExp>;
  requiredTools?: string[];
  optionalTools?: string[];
  forbiddenTools?: string[];
  examples?: Array<{ input: string; expectedTools: string[] }>;
  canHandle(context: SkillContext): boolean;
  run(context: SkillContext): Promise<SkillResult>;
}

export class SkillRegistry {
  constructor(private readonly skills: AgentSkill[]) {}
  list() { return this.skills.map(({ canHandle: _canHandle, run: _run, ...metadata }) => metadata); }
  select(context: SkillContext) { return this.skills.find((skill) => skill.canHandle(context)); }
  get(id: string) { return this.skills.find((skill) => skill.id === id); }
}
