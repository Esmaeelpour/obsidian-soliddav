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

const DEFAULT_TTL_MS = 2 * 60 * 1000;

/**
 * A stable lock-owner id for THIS device, persisted across syncs and restarts.
 * Critical: if the owner changed every run, a sync interrupted before releasing
 * its lock (common on mobile) would leave a lock that the device's own next run
 * sees as "someone else's" and refuses — blocking its own syncs. With a stable
 * id, a device always recognizes and overrides its own leftover lock.
 */
export function getStableLockOwner(): string {
	const KEY = 'soliddav-lock-owner';
	try {
		let value = localStorage.getItem(KEY);
		if (!value) {
			value = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(KEY, value);
		}
		return value;
	} catch {
		return `dev-${Math.random().toString(36).slice(2, 10)}`;
	}
}

type LockPayload = {
	owner: string;
	timestamp: number;
};

async function readLock(client: WebDAVClient): Promise<LockPayload | undefined> {
	try {
		// Single GET instead of exists()+getFileContents() — saves one round-trip.
		const raw = (await client.getFileContents(REMOTE_LOCK_FILENAME, {
			format: 'text',
		})) as string;
		const parsed = JSON.parse(raw) as LockPayload;
		if (typeof parsed.owner !== 'string' || typeof parsed.timestamp !== 'number')
			return undefined;
		return parsed;
	} catch (error) {
		const status = (error as { status?: number })?.status;
		// 404 = no lock file yet; 405 = server doesn't support the method on this path.
		if (status === 404 || status === 405) return undefined;
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
		if (!existing || existing.owner === owner)
			// Best-effort delete; ignore 404 in case another client already cleaned up.
			await client.deleteFile(REMOTE_LOCK_FILENAME).catch(() => undefined);
	} catch (error) {
		logger.warn('Failed to release remote sync lock', error);
	}
}
