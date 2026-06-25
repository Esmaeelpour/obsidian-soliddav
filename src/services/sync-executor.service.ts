import type WebDAVSyncPlugin from '~';
import type { SyncRunSnapshot, SyncTrigger } from '~/events';
import type { BaseTask } from '~/sync/tasks/task.interface';
import type { SyncRunKind } from '~/types';
import { createQueuedSyncRunSnapshot, syncRun, updateSyncRunSnapshot } from '~/events';
import finalizeSyncRun from '~/events/sync-terminate';
import { traverseVault } from '~/fs/vault';
import { traverseWebDAV } from '~/fs/webdav';
import SyncEngine from '~/sync';
import { isRemoteBaseDirNotFoundError, isSyncCancelledError } from '~/sync/errors';
import logger from '~/utils/logger';
import waitUntil from '~/utils/wait-until';

export type SyncOptions = {
	runKind: SyncRunKind;
};

export type SyncExecutionRequest = {
	runId: string;
	trigger: SyncTrigger;
	sources: Array<SyncTrigger>;
	queuedAt: number;
} & SyncOptions;

export type SyncExecutionResult = {
	executed: boolean;
	run?: SyncRunSnapshot;
};

export default class SyncExecutorService {
	constructor(private readonly plugin: WebDAVSyncPlugin) {}

	async executeSync(request: SyncExecutionRequest): Promise<SyncExecutionResult> {
		if (this.plugin.isSyncing) return { executed: false };
		// Monitor-only devices never write — they just report in-sync status (and
		// surface a clear 'not configured' status if the connection isn't set up).
		if (this.plugin.settings.operatingMode === 'monitor') return this.runMonitorCheck();
		if (!this.plugin.isAccountConfigured()) return { executed: false };
		await waitUntil(() => !this.plugin.isSyncing, 500);
		logger.pushRunId(request.runId);

		try {
			this.plugin.prepareSyncEncryptionKeys();

			const sync = new SyncEngine(this.plugin, {
				token: this.plugin.getToken(),
				vault: this.plugin.app.vault,
				webdav: this.plugin.webDAVService.createWebDAVClient(),
			});

			let run = createQueuedSyncRunSnapshot({
				queuedAt: request.queuedAt,
				runId: request.runId,
				runKind: request.runKind,
				sources: request.sources,
				trigger: request.trigger,
			});
			run = updateSyncRunSnapshot(run, {
				serverUrl: this.plugin.settings.serverUrl,
				stage: 'pre_connecting',
				timestamps: { planningStartedAt: Date.now() },
			});
			syncRun(run);
			logger.info('Planning started');

			let tasks: Array<BaseTask> | undefined;
			try {
				tasks = await sync.preparePlan(request.runKind, (patch) => {
					run = updateSyncRunSnapshot(run, patch);
					syncRun(run);
				});
			} catch (error) {
				run = finalizeSyncRun(run, {
					error,
					stage: isSyncCancelledError(error) ? 'cancelled' : 'failed',
				});
				return { executed: true, run };
			}

			run = updateSyncRunSnapshot(run, {
				planSummary: sync.summarizePlan(tasks),
			});
			syncRun(run);
			logger.info(`Planning finished with ${tasks.length} tasks`);

			run = await sync.start({
				request,
				run,
				tasks,
			});

			return { executed: true, run };
		} finally {
			this.plugin.clearSyncEncryptionKeys();
			logger.popRunId();
		}
	}

	/** Read-only check used in monitor mode: compares the local vault against the
	 * server directly (no writes, no baseline needed) and reports how many files
	 * differ. Baseline-independent so it works on a device that never syncs. */
	private async runMonitorCheck(): Promise<SyncExecutionResult> {
		if (!this.plugin.isAccountConfigured()) {
			this.plugin.observabilityService.reportMonitorResult({ notConfigured: true });
			return { executed: false };
		}
		this.plugin.toggleSyncUI(true);
		this.plugin.observabilityService.reportMonitorChecking();
		try {
			this.plugin.prepareSyncEncryptionKeys();
			const pending = await this.compareLocalAndRemote();
			this.plugin.observabilityService.reportMonitorResult({ pending });
			return { executed: false };
		} catch (error) {
			logger.error('Monitor check failed', error);
			this.plugin.observabilityService.reportMonitorResult(
				isRemoteBaseDirNotFoundError(error) ? { remoteMissing: true } : { error: true },
			);
			return { executed: false };
		} finally {
			this.plugin.clearSyncEncryptionKeys();
			this.plugin.toggleSyncUI(false);
		}
	}

	/** Count files that differ between the local vault and the server. Both
	 * traversals already apply the same filter rules. Size is compared unless
	 * encryption is on (encrypted sizes differ), in which case presence only.
	 *
	 * Unlike a real sync, this is baseline-independent, so the only cross-device
	 * signal available is byte size — etag/mtime are unreliable across devices.
	 * Some WebDAV servers omit `getcontentlength` from directory listings, which
	 * parses as size 0 (see fs/webdav/api.ts). If we naively compared that, every
	 * non-empty file would look different and the status would be stuck on
	 * "Pending" forever, even though real syncs (which use etags/baseline)
	 * succeed. So a size difference is only trusted when the remote reports a
	 * positive size — an unreported (0) remote size is treated as "unknown". */
	private async compareLocalAndRemote(): Promise<number> {
		const [localStats, remoteStats] = await Promise.all([
			traverseVault({ vault: this.plugin.app.vault }),
			traverseWebDAV({ token: this.plugin.getToken() }),
		]);
		const compareSize = !this.plugin.settings.encryption.enabled;
		const paths = new Set<string>([...localStats.keys(), ...remoteStats.keys()]);
		let pending = 0;
		const diffs: Array<string> = [];
		for (const path of paths) {
			const local = localStats.get(path);
			const remote = remoteStats.get(path);
			if (!local || !remote) {
				// Present on only one side — count it only if a file (not a folder).
				if ((local && !local.isDir) || (remote && !remote.isDir)) {
					pending++;
					diffs.push(`${path} (only ${local ? 'local' : 'remote'})`);
				}
				continue;
			}
			if (local.isDir || remote.isDir) continue; // folders are implicit
			/* Skip when the server didn't report a size (remote.size === 0): a truly
			 * empty file can't be told apart from an unreported length, so treating
			 * it as a difference would risk a permanently "Pending" status. */
			if (compareSize && remote.size > 0 && local.size !== remote.size) {
				pending++;
				diffs.push(`${path} (size ${local.size} local vs ${remote.size} remote)`);
			}
		}
		if (diffs.length > 0) {
			const shown = diffs.slice(0, 20).join(', ');
			const overflow = diffs.length > 20 ? `, …(+${diffs.length - 20} more)` : '';
			logger.debug(`Monitor: ${pending} pending file(s): ${shown}${overflow}`);
		}
		return pending;
	}
}
