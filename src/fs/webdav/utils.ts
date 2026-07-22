import type { WebDAVClient } from 'webdav';
import type { BinaryLike } from '~/platform/binary';
import { toArrayBuffer } from '~/platform/binary';
import { usePlugin } from '~/settings';
import isRetryableError from '~/utils/is-retryable-error';
import logger from '~/utils/logger';
import sleep from '~/utils/sleep';
import { getStat, REMOTE_TEMP_MARKER } from './api';

type PutContent = Parameters<WebDAVClient['putFileContents']>[1];

export type PutResult = {
	etag?: string;
};

/**
 * Upload atomically: PUT to a temp sibling, then MOVE it over the target. A PUT
 * interrupted mid-stream (common on mobile) leaves only the temp file, so the
 * real file is never left truncated/corrupt. Returns response metadata (including ETag if returned).
 */
export async function putFileContentsAtomic(
	client: WebDAVClient,
	finalPath: string,
	content: PutContent,
): Promise<PutResult> {
	const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${finalPath}${REMOTE_TEMP_MARKER}${rand}.tmp`;

	let putAttempts = 0;
	let etag: string | undefined;

	while (true)
		try {
			const putOptions = {
				details: true,
				overwrite: true,
			} as unknown as Parameters<WebDAVClient['putFileContents']>[2];
			const res = (await client.putFileContents(tempPath, content, putOptions)) as unknown as {
				headers?: Record<string, string>;
			};
			if (!res) throw new Error(`Upload failed for ${finalPath}`);
			etag = res.headers?.etag ?? res.headers?.ETag;
			break;
		} catch (error) {
			putAttempts++;
			if (putAttempts <= 3 && isRetryableError(error)) {
				logger.warn(
					`PUT failed for ${finalPath} (attempt ${putAttempts}), retrying…`,
					error,
				);
				await sleep(putAttempts * 2000);
				continue;
			}
			throw error;
		}

	let moveAttempts = 0;
	while (true) {
		try {
			const moveOptions = {
				details: true,
			} as unknown as Parameters<WebDAVClient['moveFile']>[2];
			const res = (await client.moveFile(tempPath, finalPath, moveOptions)) as unknown as {
				headers?: Record<string, string>;
			};
			etag = res?.headers?.etag ?? res?.headers?.ETag ?? etag;
			if (etag) {
				etag = etag.replace(/^W\//, '').replace(/^"|"$/g, '');
			}
			return { etag };
		} catch (error) {
			moveAttempts++;
			if (moveAttempts <= 3 && isRetryableError(error)) {
				logger.warn(
					`MOVE failed for ${finalPath} (attempt ${moveAttempts}), retrying…`,
					error,
				);
				await sleep(moveAttempts * 2000);
				continue;
			}
			// Best-effort cleanup so a failed MOVE doesn't leave the temp behind.
			await client.deleteFile(tempPath).catch(() => undefined);
			throw error;
		}
	}
}

export async function statItem(path: string, statPath = path) {
	const plugin = await usePlugin();
	return Object.assign(await getStat(plugin.settings.serverUrl, plugin.getToken(), path), {
		statPath,
	});
}

export async function getContent(webdav: WebDAVClient, path: string) {
	if (path.endsWith('/')) throw new Error(`Cannot read a folder as a file: ${path}`);
	const content = (await webdav.getFileContents(path)) as BinaryLike;
	return toArrayBuffer(content);
}

export function mkdirsWebDAV(client: WebDAVClient, path: string) {
	return client.createDirectory(path, {
		recursive: true,
	});
}
