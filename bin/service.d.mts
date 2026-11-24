export const SERVICE_NAME: string;
export const FIXED_PORT: number;
export const LOOPBACK: string;
export const ALL_INTERFACES: string;
export function validatePort(value: unknown): number;
export function validateHost(value: unknown): string;
export function localAddresses(): string[];
export function renderUnit(options: { launcher: string; port: number; host?: string; path: string }): string;
export function servicePath(flags?: { path?: string }): string;
export function installService(options: {
	appRoot: string;
	flags?: Record<string, string | undefined>;
	run?: (argv: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
	out?: (line: string) => void;
}): Promise<{ unitPath: string; port: number; host: string; launcher: string }>;
export function serviceStatus(options: {
	flags?: Record<string, string | undefined>;
	run?: (argv: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
	out?: (line: string) => void;
}): Promise<{ installed: boolean; active: boolean; unitPath: string }>;
export function removeService(options: {
	flags?: Record<string, string | undefined>;
	run?: (argv: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
	out?: (line: string) => void;
}): Promise<{ removed: boolean; unitPath: string }>;
