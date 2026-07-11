import type { OptionsWithLocalFileStat } from '~/sync/decision/sync-decision.interface';
import { getContent } from '~/fs/vault';
import { putFileContentsAtomic, statItem } from '~/fs/webdav';
import { arrayBufferToText } from '~/platform/binary';
import { encryptContentForRemoteFile, resolveRemoteExecutionPath } from '~/utils/encryption';
import logger from '~/utils/logger';
import isMergeablePath from '../utils/is-mergeable-path';
import { BaseTask, toTaskError } from './task.interface';

export default class PushTask extends BaseTask<OptionsWithLocalFileStat> {
	readonly name = 'upload';

	async exec() {
		try {
			let localContent: ArrayBuffer;
			try {
				localContent = await getContent(this.vault, this.localPath);
			} catch {
				// Ignore if local not found (which indicates that it has been deleted or renamed, common in case of a fast local change)
				logger.warn(`Failed to get local content at path \`${this.localPath}\``);
				return { success: true } as const;
			}
			const executionRemotePath = await resolveRemoteExecutionPath(this.remotePath);
			const uploadContent = await encryptContentForRemoteFile(this.localPath, localContent);

			await putFileContentsAtomic(this.webdav, executionRemotePath, uploadContent);

			const baseText = isMergeablePath(this.localPath)
				? await arrayBufferToText(localContent)
				: undefined;

			/* Persist the record immediately after the upload lands, before the extra
			 * PROPFIND round-trip. If the app is suspended/killed between the upload
			 * and the record write (common on mobile), the stale record makes the next
			 * run see a bogus "both sides changed" conflict against our own push and
			 * decorate the note with merge markers. With this provisional record the
			 * base text already equals the uploaded content, so the next run resolves
			 * clean. The synthesized remote stat (no etag) at worst causes one
			 * harmless self-healing pull of identical content. */
			const provisionalRemote = {
				isDir: false as const,
				mtime: Date.now(),
				path: this.remotePath,
				size: uploadContent.byteLength,
			};
			await this.syncRecord.upsertRecords({
				baseText,
				key: this.localPath,
				local: this.local,
				remote: provisionalRemote,
			});

			const remote = await statItem(executionRemotePath, this.remotePath);
			if (!remote || remote.isDir)
				throw new Error(`failed to read remote file stat after push: ${this.localPath}`);

			await this.syncRecord.upsertRecords({
				baseText,
				key: this.localPath,
				local: this.local,
				remote,
			});

			return { success: true } as const;
		} catch (error) {
			logger.error(
				`Failed to push local file ${this.localPath} to remote path ${this.remotePath}`,
				error,
			);
			return { error: toTaskError(error, this), success: false };
		}
	}
}
