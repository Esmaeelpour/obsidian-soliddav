import type { WebDAVClient } from 'webdav';
import { REMOTE_LOCK_FILENAME } from '~/fs/webdav';
import logger from '~/utils/logger';

/**
 * A best-effort advisory lock kept as a small file on the remote, so two devices
 * (or an auto-sync racing a manual sync) don't execute writes against the same
 * remote at the same time and interleave into an inconsistent state. The lock is
 * cooperative: it relies on every client honoring it, and a TTL prevents a
 * crashed client from blocking syncing forever.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type LockPayload = {
	owner: string;
	timestamp: number;
};

async function readLock(client: WebDAVClient): Promise<LockPayload | undefined> {
	try {
		if (!(await client.exists(REMOTE_LOCK_FILENAME))) return undefined;
		const raw = (await client.getFileContents(REMOTE_LOCK_FILENAME, {
			format: 'text',
		})) as string;
		const parsed = JSON.parse(raw) as LockPayload;
		if (typeof parsed.owner !== 'string' || typeof parsed.timestamp !== 'number')
			return undefined;
		return parsed;
	} catch (error) {
		// A corrupt/unreadable lock is treated as absent so it can be overwritten.
		logger.warn('Failed to read remote sync lock, treating as absent', error);
		return undefined;
	}
}

/**
 * Try to take the lock. Returns true if acquired (or if the lock is ours/stale),
 * false if another live client currently holds it.
 */
export async function acquireRemoteLock(
	client: WebDAVClient,
	owner: string,
	ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
	const existing = await readLock(client);
	if (existing && existing.owner !== owner && Date.now() - existing.timestamp < ttlMs) {
		logger.info(`Remote held by another client (${existing.owner}); skipping this run`);
		return false;
	}
	const payload: LockPayload = { owner, timestamp: Date.now() };
	await client.putFileContents(REMOTE_LOCK_FILENAME, JSON.stringify(payload), {
		overwrite: true,
	});
	return true;
}

/** Release the lock, but only if we still own it. */
export async function releaseRemoteLock(client: WebDAVClient, owner: string): Promise<void> {
	try {
		const existing = await readLock(client);
		if (!existing || existing.owner === owner) {
			if (await client.exists(REMOTE_LOCK_FILENAME))
				await client.deleteFile(REMOTE_LOCK_FILENAME);
		}
	} catch (error) {
		logger.warn('Failed to release remote sync lock', error);
	}
}
