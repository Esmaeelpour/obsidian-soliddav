import type { OptionsWithBothFileStats } from '~/sync/decision/sync-decision.interface';
import { statItem } from '~/fs/webdav';
import { resolveRemoteExecutionPath } from '~/utils/encryption';
import logger from '~/utils/logger';
import type { BaseTaskOptions } from './task.interface';
import { BaseTask, toTaskError } from './task.interface';

export type RenameRemoteTaskOptions = BaseTaskOptions &
	OptionsWithBothFileStats & {
		/** The record's previous local path (this task's `localPath`/`remotePath`
		 * describe the new location the file now lives at). */
		oldLocalPath: string;
		oldRemotePath: string;
	};

/**
 * A local file was detected as a rename/move of a previously-synced file
 * (identical content, different path — see detect-renames.ts). Moves the
 * remote copy instead of deleting the old path and re-uploading the full
 * content under the new one, replacing what would otherwise be a
 * RemoveRemoteTask + PushTask pair.
 */
export default class RenameRemoteTask extends BaseTask<OptionsWithBothFileStats> {
	readonly name = 'renameRemote';

	constructor(options: RenameRemoteTaskOptions) {
		super(options);
		this.oldLocalPath = options.oldLocalPath;
		this.oldRemotePath = options.oldRemotePath;
	}

	readonly oldLocalPath: string;
	readonly oldRemotePath: string;

	async exec() {
		try {
			const oldExecutionPath = await resolveRemoteExecutionPath(this.oldRemotePath);
			const newExecutionPath = await resolveRemoteExecutionPath(this.remotePath);

			await this.webdav.moveFile(oldExecutionPath, newExecutionPath);
			await this.syncRecord.removeRecords(this.oldLocalPath);

			const remote = await statItem(newExecutionPath, this.remotePath);
			if (!remote || remote.isDir)
				throw new Error(`failed to read remote file stat after rename: ${this.remotePath}`);

			await this.syncRecord.upsertRecords({
				key: this.localPath,
				local: this.local,
				remote,
			});

			return { success: true } as const;
		} catch (error) {
			logger.error(
				`Failed to rename remote file ${this.oldRemotePath} to ${this.remotePath}`,
				error,
			);
			return { error: toTaskError(error, this), success: false };
		}
	}
}
