import { rmSync } from "node:fs";

/**
 * Remove a throwaway tree a test made.
 *
 * A daemon asked to stop is only asked: its own children may still be writing a probe file into
 * the tree for a moment after, and one removal then fails with ENOTEMPTY although nothing is
 * wrong with what the test proved. The removal is retried until those writers are done, and it
 * still fails loudly when they never are.
 */
export async function removeTree(folder: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			rmSync(folder, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 9) throw error;
			await new Promise((done) => setTimeout(done, 100));
		}
	}
}
