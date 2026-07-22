/**
 * Calculates exponential backoff delay with randomized full jitter to prevent
 * thundering-herd issues on flaky or mobile connections.
 *
 * @param attempt 1-indexed attempt number
 * @param baseMs Initial base delay in milliseconds (default: 1000)
 * @param maxMs Maximum capped delay in milliseconds (default: 8000)
 */
export function getBackoffDelay(attempt: number, baseMs = 1000, maxMs = 8000): number {
	const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
	const jitter = Math.random() * 500;
	return Math.min(maxMs, Math.floor(exp + jitter));
}
