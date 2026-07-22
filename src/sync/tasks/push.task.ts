import type { OptionsWithLocalFileStat } from '~/sync/decision/sync-decision.interface';
import type { FileStatModel } from '~/types';
import { getContent } from '~/fs/vault';
import { putFileContentsAtomic, statItem } from '~/fs/webdav';
import { arrayBufferToText } from '~/platform/binary';
import hashContent from '~/utils/content-hash';
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

			/* Confirm this is a real edit before uploading — only when the decider
			 * has told us the remote side is unchanged (`this.remote` set), i.e. this
			 * push exists solely because local looked changed by mtime/size. Content
			 * can look "changed" without actually differing: OS-level touches
			 * (iCloud metadata, media indexers) bump mtime with no byte change. An
			 * upload here would be wasted bandwidth at best and a spurious record
			 * churn at worst — skip it when the bytes match what was last synced. */
			if (this.remote && !this.remote.isDir) {
				const skipped = isMergeablePath(this.localPath)
					? await this.skipIfTextUnchanged(localContent, this.remote)
					: await this.skipIfHashUnchanged(localContent, this.remote);
				if (skipped) return { success: true } as const;
			}

			const executionRemotePath = await resolveRemoteExecutionPath(this.remotePath);
			const uploadContent = await encryptContentForRemoteFile(this.localPath, localContent);

			const putResult = await putFileContentsAtomic(
				this.webdav,
				executionRemotePath,
				uploadContent,
			);

			const baseText = isMergeablePath(this.localPath)
				? await arrayBufferToText(localContent)
				: undefined;
			// Stored only for binary files — mergeable files already get an
			// equivalent, cheaper check via baseText (see skipIfTextUnchanged).
			const hash = isMergeablePath(this.localPath) ? undefined : await hashContent(localContent);
			const local = { ...this.local, hash };

			let remote;
			if (putResult?.etag) {
				remote = {
					etag: putResult.etag,
					isDir: false as const,
					mtime: Date.now(),
					path: this.remotePath,
					size: uploadContent.byteLength,
				};
			} else {
				/* Persist provisional record before extra PROPFIND round-trip. */
				const provisionalRemote = {
					isDir: false as const,
					mtime: Date.now(),
					path: this.remotePath,
					size: uploadContent.byteLength,
				};
				await this.syncRecord.upsertRecords({
					baseText,
					key: this.localPath,
					local,
					remote: provisionalRemote,
				});

				const readRemote = await statItem(executionRemotePath, this.remotePath);
				if (!readRemote || readRemote.isDir)
					throw new Error(`failed to read remote file stat after push: ${this.localPath}`);
				remote = readRemote;
			}

			await this.syncRecord.upsertRecords({
				baseText,
				key: this.localPath,
				local,
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

	/** Text files: compare against the stored base text (already maintained for
	 * 3-way merges) — no hash needed. On a match, refresh the record's local
	 * stat only, so this exact false positive doesn't repeat next run. */
	private async skipIfTextUnchanged(
		localContent: ArrayBuffer,
		remote: FileStatModel,
	): Promise<boolean> {
		const baseText = await this.syncRecord.getBaseText(this.localPath);
		if (baseText === undefined) return false;
		const localText = await arrayBufferToText(localContent);
		if (localText !== baseText) return false;
		await this.syncRecord.upsertRecords({
			baseText,
			key: this.localPath,
			local: this.local,
			remote,
		});
		return true;
	}

	/** Binary files: compare against the hash stored on the last matching sync
	 * record. On a match, refresh the record's local stat only. */
	private async skipIfHashUnchanged(
		localContent: ArrayBuffer,
		remote: FileStatModel,
	): Promise<boolean> {
		const previous = await this.syncRecord.getRecord(this.localPath);
		const previousHash = previous && !previous.local.isDir ? previous.local.hash : undefined;
		if (!previousHash) return false;
		const currentHash = await hashContent(localContent);
		if (currentHash !== previousHash) return false;
		await this.syncRecord.upsertRecords({
			key: this.localPath,
			local: { ...this.local, hash: currentHash },
			remote,
		});
		return true;
	}
}
