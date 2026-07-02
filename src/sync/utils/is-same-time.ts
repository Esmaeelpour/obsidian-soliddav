/** Two-second window: covers FAT32/exFAT 2 s mtime granularity and minor
 * OS-level mtime jitter (iCloud metadata touches, etc.) without risking
 * missed edits — a real content change produces an mtime shift of minutes or
 * more, and the size check catches same-size edits independently. */
const MTIME_TOLERANCE_MS = 2000;

export default function isSameTime(
	timestamp1?: Date | number,
	timestamp2?: Date | number,
): boolean {
	if (timestamp1 === undefined || timestamp2 === undefined) return false;

	const time1 = typeof timestamp1 === 'number' ? timestamp1 : timestamp1.getTime();
	const time2 = typeof timestamp2 === 'number' ? timestamp2 : timestamp2.getTime();

	return Math.abs(time1 - time2) <= MTIME_TOLERANCE_MS;
}
