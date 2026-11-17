export type ClipItem = { path: string; name: string; kind: string };
export type Clip = { mode: "cut" | "copy"; items: ClipItem[]; from?: string };
export function clipboardLabel(clip: Clip | null | undefined): string;
export function isSameOrInside(child: string, parent: string, sep?: string): boolean;
export function uniquePasteName(name: string, taken: Set<string> | string[]): string;
export function pasteProblem(clip: Clip | null | undefined, dest: string, sep?: string): string;
export function parentOf(p: string, sep?: string): string;
