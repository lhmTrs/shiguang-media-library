export type ScriptMapIssue = {code: string; path: string; message: string; severity: 'error' | 'warning'; candidateLines?: number[]};
export function validateScriptMap(graph: unknown): {issues: ScriptMapIssue[]};
