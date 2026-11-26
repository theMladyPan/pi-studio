export type ScopeTier = "empty" | "trivial" | "middle" | "core";
export declare const FULL_BRANCHES: string[];
export function classifyFiles(files: string[]): { tier: ScopeTier; reasons: string[]; files: string[] };
export function currentBranch(repo: string): string;
export function changedFiles(repo: string): string[];
export function adviceFor(branch: string, tier: ScopeTier): string;
export function scopeSummary(repo: string): string;
export function shouldForceFull(opts?: { fullFlag?: boolean; env?: NodeJS.ProcessEnv }): boolean;
