export function pluginNameOf(url: string): string;
export function addPlugin(
	url: string,
	options?: { flags?: Record<string, string | undefined>; stream?: boolean },
): Promise<{ name: string; updated: boolean; dir: string }>;
