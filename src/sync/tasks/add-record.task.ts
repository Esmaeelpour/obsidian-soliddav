import { getContent } from '~/fs/vault';
import { arrayBufferToText } from '~/platform/binary';
import logger from '~/utils/logger';
import type { OptionsWithBothStats } from '../decision/sync-decision.interface';
import isMergeablePath from '../utils/is-mergeable-path';
import { BaseTask, toTaskError } from './task.interface';

export default class AddRecordTask extends BaseTask<OptionsWithBothStats> {
	readonly name = 'addRecord';
	async exec() {
		try {
			/* Capture the base text alongside the record. Without it a later
			 * conflict on this file has no merge base, and the fallback resolution
			 * can silently prefer one side — the classic "my edits disappeared
			 * after sync" report. Best-effort: a record without base is still
			 * better than no record. */
			let baseText: string | undefined;
			if (!this.local.isDir && isMergeablePath(this.localPath))
				try {
					baseText = await arrayBufferToText(
						await getContent(this.vault, this.localPath),
					);
				} catch {
					logger.warn(`addRecord: could not read base text for ${this.localPath}`);
				}

			await this.syncRecord.upsertRecords({
				baseText,
				key: this.localPath,
				local: this.local,
				remote: this.remote,
			});
			return { success: true } as const;
		} catch (error) {
			logger.error(`Failed to add record for ${this.localPath}`, error);
			return { error: toTaskError(error, this), success: false };
		}
	}
}
