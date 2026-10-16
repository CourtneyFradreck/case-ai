export interface ModelResult { raw: string; model: string; inputTokens?: number; outputTokens?: number }
export interface BriefModel { name: string; generate(system: string, user: string, jsonSchema: object): Promise<ModelResult> }
