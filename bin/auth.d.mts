export const SCRYPT_PARAMS: { N: number; r: number; p: number };
export const MAX_PASSWORD_CHARS: number;
export function authFileOf(flags?: Record<string, string | undefined>): string;
export function hashPassword(password: string): { v: number; algo: string; N: number; r: number; p: number; salt: string; hash: string; createdAt: string };
export function setPassword(options?: {
	flags?: Record<string, string | undefined>;
	ask?: (question: string) => Promise<string>;
	out?: (line: string) => void;
}): Promise<{ file: string }>;
export function removePassword(options?: {
	flags?: Record<string, string | undefined>;
	out?: (line: string) => void;
}): { removed: boolean; file: string };
