export type PromptSplit = {style: string; lyrics: string; params: string; how: 'empty' | 'headers' | 'markers' | 'style-only' | 'style-paragraph' | 'unsure'};
export function splitSunoPrompt(text: string | null | undefined): PromptSplit;
export function isMarkerToken(token: string): boolean;
