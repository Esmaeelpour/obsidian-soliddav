import type { OptionsWithBothFileStats } from '~/sync/decision/sync-decision.interface';
import type { StatModel } from '~/types';
import { getContent as getLocalContent, statItem as statVaultItem } from '~/fs/vault';
import {
	getContent as getRemoteContent,
	putFileContentsAtomic,
	statItem as statWebDAVItem,
} from '~/fs/webdav';
import { arrayBufferEquals, arrayBufferToText } from '~/platform/binary';
import { useSettings } from '~/settings';
import {
	decryptRemoteFileContent,
	encryptContentForRemoteFile,
	resolveRemoteExecutionPath,
} from '~/utils/encryption';
import logger from '~/utils/logger';
import mergeDigIn from '~/utils/merge-dig-in';
import { resolveByIntelligentMerge } from '../utils/merge';
import { BaseTask, toTaskError } from './task.interface';

export default class MergeTask extends BaseTask<OptionsWithBothFileStats> {
	readonly name = 'merge';

	async exec() {
		try {
			let localBuffer: ArrayBuffer;
			try {
				localBuffer = await getLocalContent(this.vault, this.localPath);
			} catch {
				// Ignore if local not found (which indicates that it has been deleted or renamed, common in case of a fast local change)
				logger.warn(`Failed to get local content at path \`${this.localPath}\``);
				return { success: true } as const;
			}

			const settings = await useSettings();
			const executionRemotePath = await resolveRemoteExecutionPath(this.remotePath);

			const downloadedRemoteBuffer = await getRemoteContent(this.webdav, executionRemotePath);
			const remoteBuffer = settings.encryption.enabled
				? await decryptRemoteFileContent(
						this.localPath,
						downloadedRemoteBuffer,
						this.remote.size,
					)
				: downloadedRemoteBuffer;

			if (arrayBufferEquals(localBuffer, remoteBuffer)) {
				await this.syncRecord.upsertRecords({
					baseText: await arrayBufferToText(localBuffer),
					key: this.localPath,
					local: this.local,
					remote: this.remote,
				});
				return { success: true } as const;
			}

			const localText = await arrayBufferToText(localBuffer);
			const remoteText = await arrayBufferToText(remoteBuffer);
			/* No stored base means we can't 3-way merge. Falling back to localText
			 * would make diff3 see local as "unchanged" and silently resolve to the
			 * remote version — discarding the user's current edits. Fall back to
			 * remoteText instead: local edits win and get pushed, which is the least
			 * surprising outcome for the device the user is actively typing on. */
			const baseText = (await this.syncRecord.getBaseText(this.localPath)) ?? remoteText;
			let mergedText: string;
			const mergeResult = resolveByIntelligentMerge({
				baseContentText: baseText,
				localContentText: localText,
				remoteContentText: remoteText,
			});

			if (mergeResult.isIdentical) {
				await this.syncRecord.upsertRecords({
					baseText: localText,
					key: this.localPath,
					local: this.local,
					remote: this.remote,
				});
				return { success: true } as const;
			}

			if (!mergeResult.success) {
				const mergeDigInResult = mergeDigIn(localText, baseText, remoteText, {
					stringSeparator: '\n',
					useGitStyle: settings.useGitStyle,
				});
				mergedText = mergeDigInResult.result.join('\n');
			} else mergedText = mergeResult.mergedText as string;

			let newRemote: StatModel | undefined;
			let newLocal: StatModel | undefined;
			const mergedBuffer = new TextEncoder().encode(mergedText).buffer;
			if (mergedText !== remoteText) {
				await putFileContentsAtomic(
					this.webdav,
					executionRemotePath,
					settings.encryption.enabled
						? await encryptContentForRemoteFile(this.localPath, mergedBuffer)
						: mergedText,
				);
				/* Durable record right after the remote write (see push.task.ts): if the
				 * app is suspended before the record refresh below, the next run heals
				 * cleanly instead of re-detecting a conflict against our own write. */
				await this.syncRecord.upsertRecords({
					baseText: mergedText,
					key: this.localPath,
					local: this.local,
					remote: {
						isDir: false,
						mtime: Date.now(),
						path: this.remotePath,
						size: mergedBuffer.byteLength,
					},
				});
				const fetchedRemoteStat = await statWebDAVItem(
					executionRemotePath,
					this.remotePath,
				);
				if (!fetchedRemoteStat || fetchedRemoteStat.isDir)
					throw new Error(
						`failed to read remote file stat after intelligent merge: ${this.localPath}`,
					);
				newRemote = fetchedRemoteStat;
			}
			if (localText !== mergedText) {
				await this.vault.adapter.writeBinary(this.localPath, mergedBuffer, {
					ctime: this.remote.mtime - 1000,
				});
				const fetchedLocalStat = await statVaultItem(this.vault, this.localPath);
				if (!fetchedLocalStat || fetchedLocalStat.isDir)
					throw new Error(
						`failed to read local file stat after intelligent merge: ${this.localPath}`,
					);
				newLocal = fetchedLocalStat;
			}

			await this.syncRecord.upsertRecords({
				baseText: mergedText,
				key: this.localPath,
				local: newLocal ?? this.local,
				remote: newRemote ?? this.remote,
			});
			return { success: true } as const;
		} catch (error) {
			logger.error(
				`Failed to resolve conflict for ${this.localPath} by smart merging`,
				error,
			);
			return { error: toTaskError(error, this), success: false };
		}
	}
}
