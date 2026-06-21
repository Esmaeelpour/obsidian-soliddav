import type { WebDAVClient } from 'webdav';
import type { BinaryLike } from '~/platform/binary';
import { toArrayBuffer } from '~/platform/binary';
import { usePlugin } from '~/settings';
import { getStat, REMOTE_TEMP_MARKER } from './api';

type PutContent = Parameters<WebDAVClient['putFileContents']>[1];

/**
 * Upload atomically: PUT to a temp sibling, then MOVE it over the target. A PUT
 * interrupted mid-stream (common on mobile) leaves only the temp file, so the
 * real file is never left truncated/corrupt. Returns the temp path's stat-able
 * final destination on success.
 */
export async function putFileContentsAtomic(
	client: WebDAVClient,
	finalPath: string,
	content: PutContent,
): Promise<void> {
	const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${finalPath}${REMOTE_TEMP_MARKER}${rand}.tmp`;
	const ok = await client.putFileContents(tempPath, content, { overwrite: true });
	if (!ok) throw new Error(`Upload failed for ${finalPath}`);
	try {
		await client.moveFile(tempPath, finalPath);
	} catch (error) {
		// Best-effort cleanup so a failed MOVE doesn't leave the temp behind.
		await client.deleteFile(tempPath).catch(() => undefined);
		throw error;
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
