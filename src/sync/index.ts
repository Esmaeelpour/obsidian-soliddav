import type { Vault } from 'obsidian';
import type { WebDAVClient } from 'webdav';
import type {
	SyncFailedTaskInfo,
	SyncProgressSummary,
	SyncRunSnapshot,
	ProgressPatch,
	SyncPlanSummary,
} from '~/events';
import type { SyncExecutionRequest } from '~/services/sync-executor.service';
import DeleteConfirmModal from '~/components/DeleteConfirmModal';
import DeletionGuardModal from '~/components/DeletionGuardModal';
import { syncRun, syncCancel, updateSyncRunSnapshot } from '~/events';
import finalizeSyncRun from '~/events/sync-terminate';
import { statItem } from '~/fs/vault';
import t from '~/i18n';
import { SyncRecord } from '~/storage';
import { SyncRunKind } from '~/types';
import breakableSleep from '~/utils/breakable-sleep';
import { getBackoffDelay } from '~/utils/backoff';
import { getSyncStateKey } from '~/utils/get-sync-state-key';
import { getTaskName } from '~/utils/get-task-info';
import isRetryableError from '~/utils/is-retryable-error';
import logger from '~/utils/logger';
import type WebDAVSyncPlugin from '..';
import type { BaseTask, TaskResult } from './tasks/task.interface';
import TwoWaySyncDecider from './decision/two-way.decider';
import {
	SyncCancelledError,
	SyncRetryExhaustedError,
	isRemoteBaseDirNotFoundError,
	isSyncCancelledError,
	toError,
} from './errors';
import { acquireRemoteLock, getStableLockOwner, releaseRemoteLock } from './remote-lock';
import AddRecordTask from './tasks/add-record.task';
import CleanRecordTask from './tasks/clean-record.task';
import MkdirRemoteTask from './tasks/mkdir-remote.task';
import PushTask from './tasks/push.task';
import RemoveLocalTask from './tasks/remove-local.task';
import { TaskError } from './tasks/task.interface';
import optimizeTasks from './utils/optimize-tasks';

type SyncResultSummary = {
	totalTasks: number;
	succeededTasks: number;
	failedTasks: number;
	failed: Array<SyncFailedTaskInfo>;
};

/** Task names that delete local files (this device). */
const LOCAL_DELETE_TASK_NAMES: ReadonlySet<string> = new Set([
	'removeLocal',
	'removeLocalRecursively',
]);
/** Task names that delete remote files (propagate to other devices). */
const REMOTE_DELETE_TASK_NAMES: ReadonlySet<string> = new Set([
	'removeRemote',
	'removeRemoteRecursively',
]);

/** Remote base dirs confirmed to exist this session. Skips one PROPFIND per
 * sync — meaningful on high-latency mobile connections. Cleared for a dir when
 * a later run discovers it missing (e.g. deleted server-side). */
const confirmedBaseDirs = new Set<string>();

export default class SyncEngine {
	isCancelled = false;

	/** Per-instance identity for the advisory remote lock. */
	private readonly lockOwner = getStableLockOwner();

	private readonly unsubscribeSyncCancel: () => void;

	constructor(
		private readonly plugin: WebDAVSyncPlugin,
		private readonly options: {
			vault: Vault;
			webdav: WebDAVClient;
			token: string;
		},
	) {
		this.options = Object.freeze(this.options);
		this.unsubscribeSyncCancel = syncCancel.subscribe(() => (this.isCancelled = true));
	}

	runKind: SyncRunKind = SyncRunKind.normal;

	async preparePlan(
		runKind: SyncRunKind = SyncRunKind.normal,
		onProgress?: (progress: ProgressPatch) => void,
	): Promise<Array<BaseTask>> {
		this.runKind = runKind;
		const syncRecord = this.createSyncRecord();
		await this.ensureRemoteBaseDirReady(syncRecord);
		this.throwIfCancelled();

		try {
			const tasks = await new TwoWaySyncDecider(this, this.options.token, syncRecord).decide(
				{
					onProgress,
					throwIfCancelled: this.throwIfCancelled,
				},
			);
			this.throwIfCancelled();

			return tasks;
		} catch (error) {
			// The dir vanished after we (or the cache) confirmed it — forget it so
			// the next run re-checks and recreates it.
			if (isRemoteBaseDirNotFoundError(error)) confirmedBaseDirs.delete(this.baseDirCacheKey);
			throw error;
		}
	}

	async start({
		request,
		tasks,
		run,
	}: {
		request: SyncExecutionRequest;
		tasks: Array<BaseTask>;
		run: SyncRunSnapshot;
	}): Promise<SyncRunSnapshot> {
		let lockAcquired = false;
		try {
			this.runKind = request.runKind;

			/* Take the advisory remote lock so two full syncs don't interleave their
			 * plans. Fast realtime runs skip it: they only push local edits via
			 * atomic temp+MOVE writes and never read remote state, so interleaving
			 * with another device is already handled by etag conflict detection on
			 * the next normal run. Skipping saves 4 HTTP round-trips on the
			 * keystroke-triggered hot path — a large share of sync latency on
			 * mobile connections. */
			if (request.runKind !== SyncRunKind.fast) {
				// retryWebDAVCall so one flaky request (common on mobile) doesn't
				// fail the whole run before it even starts.
				lockAcquired = await this.retryWebDAVCall(() =>
					acquireRemoteLock(this.webdav, this.lockOwner),
				);
				if (!lockAcquired) {
					logger.info('Another client holds the remote sync lock; skipping this run');
					return finalizeSyncRun(run, { stage: 'cancelled' });
				}
			}

			const settings = this.settings;
			let currentRun = updateSyncRunSnapshot(run, {
				planSummary: this.summarizePlan(tasks),
			});
			syncRun(currentRun);
			logger.info('Execution started');

			if (tasks.length === 0) {
				currentRun = finalizeSyncRun(currentRun, {
					patch: {
						resultSummary: {
							failed: [],
							failedTasks: 0,
							succeededTasks: 0,
							totalTasks: 0,
						},
					},
					stage: 'completed_noop',
				});
				return currentRun;
			}

			// Deletion safety guard (defense-in-depth): if this run would delete more
			// files than the limit, make the user confirm before anything is removed.
			// Covers BOTH local and remote deletions (remote deletions propagate to
			// other devices, so they're the dangerous ones).
			if (settings.deletionGuardThreshold > 0) {
				const localDeletes = tasks.filter((task) =>
					LOCAL_DELETE_TASK_NAMES.has(task.name),
				).length;
				const remoteDeletes = tasks.filter((task) =>
					REMOTE_DELETE_TASK_NAMES.has(task.name),
				).length;
				if (localDeletes + remoteDeletes > settings.deletionGuardThreshold) {
					logger.warn(
						`Deletion guard: ${localDeletes + remoteDeletes} deletions exceed limit ${settings.deletionGuardThreshold}`,
					);
					currentRun = updateSyncRunSnapshot(currentRun, {
						stage: 'awaiting_confirmation',
						timestamps: { confirmationStartedAt: Date.now() },
					});
					syncRun(currentRun);
					const proceed = await new DeletionGuardModal(this.app, {
						local: localDeletes,
						remote: remoteDeletes,
					}).openAndWait();
					if (!proceed) {
						currentRun = finalizeSyncRun(currentRun, { stage: 'cancelled' });
						return currentRun;
					}
				}
			}

			const displayableTasks = tasks.filter((task) => this.isDisplayableTask(task));
			const notDisplayableTasks = tasks.filter((task) => !this.isDisplayableTask(task));

			if (this.isCancelled) {
				currentRun = finalizeSyncRun(currentRun, { stage: 'cancelled' });
				return currentRun;
			}

			if (
				request.trigger === 'manual' &&
				settings.confirmBeforeSync &&
				displayableTasks.length > 0
			) {
				currentRun = updateSyncRunSnapshot(currentRun, {
					planSummary: {
						...this.summarizePlan(tasks),
						requiresConfirmation: true,
					},
					stage: 'awaiting_confirmation',
					timestamps: {
						confirmationStartedAt: Date.now(),
					},
				});
				syncRun(currentRun);
				const confirmExec =
					await this.plugin.observabilityService.confirmManualTasks(displayableTasks);
				if (confirmExec.confirmed)
					tasks = [...notDisplayableTasks, ...confirmExec.selectedTasks];
				else {
					currentRun = finalizeSyncRun(currentRun, { stage: 'cancelled' });
					return currentRun;
				}
			}

			// Check for RemoveLocalTask during auto-sync and ask for confirmation
			if (request.trigger !== 'manual' && settings.confirmBeforeDeleteInAutoSync) {
				const removeLocalTasks = tasks.filter((task) => task instanceof RemoveLocalTask);
				const otherTasks = tasks.filter((task) => !(task instanceof RemoveLocalTask));
				if (removeLocalTasks.length > 0) {
					currentRun = updateSyncRunSnapshot(currentRun, {
						planSummary: {
							...this.summarizePlan(tasks),
							requiresDeleteConfirmation: true,
							warnings: [
								{
									code: 'delete_confirmation',
									messageKey: 'deleteConfirm.warningNotice',
								},
							],
						},
						stage: 'awaiting_confirmation',
						timestamps: {
							confirmationStartedAt:
								currentRun.timestamps.confirmationStartedAt ?? Date.now(),
						},
					});
					syncRun(currentRun);
					const { tasksToDelete, tasksToReupload } = await new DeleteConfirmModal(
						this.app,
						removeLocalTasks,
					).openAndWait();

					const reuploadTasks = await this.convertDeleteToUpload(tasksToReupload);

					tasks = [...tasksToDelete, ...reuploadTasks, ...otherTasks];
				}
			}

			const optimizedTaskGroups = optimizeTasks(
				tasks,
				settings.maxSyncTaskConcurrency,
				settings.maxThroughputConcurrency,
			);
			const optimizedTasks = optimizedTaskGroups.flat();
			const allTasksResult: Array<TaskResult> = [];

			const totalDisplayableTasks = optimizedTasks.filter((task) =>
				this.isDisplayableTask(task),
			);

			// Track all completed tasks across all batches
			const allCompletedTasks: Array<BaseTask> = [];
			currentRun = updateSyncRunSnapshot(currentRun, {
				planSummary: this.summarizePlan(optimizedTasks),
				progressSummary: this.createProgressSummary(
					totalDisplayableTasks,
					allCompletedTasks,
				),
				stage: 'executing',
				timestamps: { executionStartedAt: Date.now() },
			});
			syncRun(currentRun);

			for (const taskGroup of optimizedTaskGroups) {
				if (this.isCancelled) break;

				const groupExecution = await this.execTaskGroup(
					currentRun,
					taskGroup,
					totalDisplayableTasks,
					allCompletedTasks,
				);
				currentRun = groupExecution.run;
				allTasksResult.push(...groupExecution.results);
			}

			const resultSummary = this.createResultSummary(allTasksResult);
			const failedCount = resultSummary.failedTasks;
			currentRun = finalizeSyncRun(currentRun, {
				patch: {
					errorSummary:
						failedCount > 0
							? {
									message: t('sync.completeWithFailed', { failedCount }),
								}
							: undefined,
					progressSummary: this.createProgressSummary(
						totalDisplayableTasks,
						allCompletedTasks,
					),
					resultSummary,
				},
				stage: this.isCancelled ? 'cancelled' : failedCount > 0 ? 'failed' : 'completed',
			});
			return currentRun;
		} catch (error) {
			const failedRun = finalizeSyncRun(run, {
				error,
				stage: isSyncCancelledError(error) ? 'cancelled' : 'failed',
			});
			return failedRun;
		} finally {
			if (lockAcquired) await releaseRemoteLock(this.webdav, this.lockOwner);
			this.unsubscribeSyncCancel();
		}
	}

	summarizePlan(tasks: Array<BaseTask>): SyncPlanSummary {
		return {
			requiresConfirmation: false,
			requiresDeleteConfirmation: false,
			totalTasks: tasks.length,
			warnings: [],
		};
	}

	private async convertDeleteToUpload(tasks: Array<RemoveLocalTask>) {
		const final: Array<PushTask | MkdirRemoteTask> = [];
		for (const task of tasks) {
			const options = task.options;
			const local = await statItem(this.vault, options.localPath);
			if (!local)
				throw new Error(`Local file item not found during reupload: ${options.localPath}`);
			if (local.isDir) final.push(new MkdirRemoteTask({ ...options, local }));
			else final.push(new PushTask({ ...options, local }));
		}
		return final;
	}

	private isDisplayableTask(task: BaseTask): boolean {
		return !(task instanceof CleanRecordTask) && !(task instanceof AddRecordTask);
	}

	private createSyncRecord() {
		return new SyncRecord(
			this.getStateKey(),
			this.plugin.syncStateStore,
			this.plugin.baseTextStore,
			this.plugin.fileChunkStore,
		);
	}

	private get baseDirCacheKey() {
		return `${this.settings.serverUrl}::${this.remoteBaseDir}`;
	}

	private async ensureRemoteBaseDirReady(syncRecord: SyncRecord) {
		const webdav = this.webdav;
		const remoteBaseDir = this.remoteBaseDir;

		// Already confirmed this session — skip the PROPFIND round-trip. If the
		// dir was deleted server-side since, the traversal's root-404 handling
		// surfaces it and preparePlan invalidates this cache entry.
		if (confirmedBaseDirs.has(this.baseDirCacheKey)) return;

		let remoteBaseDirExists = await this.retryWebDAVCall(() => webdav.exists(remoteBaseDir));

		if (!remoteBaseDirExists) await syncRecord.drop();

		while (!remoteBaseDirExists) {
			this.throwIfCancelled();

			try {
				await webdav.createDirectory(remoteBaseDir, {
					recursive: true,
				});
				remoteBaseDirExists = true;
				continue;
			} catch (error) {
				if (isRetryableError(error)) {
					await breakableSleep(syncCancel, 5000);
					this.throwIfCancelled();
					// oxlint-disable-next-line no-useless-assignment
					remoteBaseDirExists = await this.retryWebDAVCall(() =>
						webdav.exists(remoteBaseDir),
					);
					continue;
				}
				throw error;
			}
		}

		confirmedBaseDirs.add(this.baseDirCacheKey);
	}

	private async execTaskGroup(
		run: SyncRunSnapshot,
		tasks: Array<BaseTask>,
		totalDisplayableTasks: Array<BaseTask>,
		allCompletedTasks: Array<BaseTask>,
	) {
		let currentRun = run;
		const tasksToDisplay = tasks.filter((task) => this.isDisplayableTask(task));
		const settledResults = await Promise.allSettled(
			tasks.map(async (task) => {
				const result = await this.executeWithRetry(task);
				if (this.isDisplayableTask(task)) {
					allCompletedTasks.push(task);
					currentRun = updateSyncRunSnapshot(currentRun, {
						progressSummary: this.createProgressSummary(
							totalDisplayableTasks,
							allCompletedTasks,
						),
					});
					syncRun(currentRun);
				}
				return result;
			}),
		);
		const results: Array<TaskResult> = settledResults.map((result, index) => {
			if (result.status === 'fulfilled') return result.value;
			const reason = result.reason;
			return {
				error: new TaskError(
					reason instanceof Error ? reason.message : String(reason),
					tasks[index],
					reason instanceof Error ? reason : undefined,
				),
				success: false,
			};
		});

		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i];
			const taskResult = results[i];
			const taskName = getTaskName(task.name);
			if (!taskResult.success)
				logger.warn('Task execution failed', {
					error: taskResult.error,
					index: i + 1,
					localPath: task.localPath,
					remotePath: task.remotePath,
					taskName,
					totalTasks: tasksToDisplay.length,
				});
		}

		return { results, run: currentRun };
	}

	private createProgressSummary(
		totalDisplayableTasks: Array<BaseTask>,
		allCompletedTasks: Array<BaseTask>,
	): SyncProgressSummary {
		return {
			completed: allCompletedTasks.map((task) => ({
				path: task.localPath,
				taskName: task.name ?? 'sync',
			})),
			completedTasks: allCompletedTasks.length,
			totalTasks: totalDisplayableTasks.length,
		};
	}

	private createResultSummary(results: Array<TaskResult>): SyncResultSummary {
		const failed: Array<SyncFailedTaskInfo> = [];

		for (const result of results)
			if (!result.success && result.error) {
				const task = result.error.task;
				failed.push({
					errorMessage: result.error.message,
					localPath: task.options.localPath,
					name: task.name,
				});
			}

		return {
			failed,
			failedTasks: failed.length,
			succeededTasks: results.filter((result) => result.success).length,
			totalTasks: results.length,
		};
	}

	/**
	 * Retry a task on transient (retryable) errors, with a hard attempt cap so a
	 * persistently failing server degrades to a failed task instead of an
	 * endless retry loop that pins the sync forever.
	 */
	private async executeWithRetry(task: BaseTask): Promise<TaskResult> {
		const MAX_ATTEMPTS = 5;
		let attempt = 0;
		while (true) {
			if (this.isCancelled)
				return {
					error: new TaskError(t('sync.cancelled'), task),
					success: false,
				};

			const taskResult = await task.exec();
			if (!taskResult.success && attempt < MAX_ATTEMPTS && isRetryableError(taskResult.error)) {
				attempt++;
				const backoff = getBackoffDelay(attempt, 1000, 8000);
				logger.warn('Retrying task after transient error', {
					attempt,
					backoff,
					error: taskResult.error,
					localPath: task.localPath,
					remotePath: task.remotePath,
					taskName: getTaskName(task.name),
				});
				await breakableSleep(syncCancel, backoff);
				if (this.isCancelled)
					return {
						error: new TaskError(t('sync.cancelled'), task),
						success: false,
					};

				continue;
			}
			return taskResult;
		}
	}

	private async retryWebDAVCall<T>(operation: () => Promise<T>) {
		let retryCount = 0;
		while (true) {
			this.throwIfCancelled();

			try {
				return await operation();
			} catch (error) {
				if (!isRetryableError(error)) {
					logger.error('WebDAV operation failed', error);
					throw toError(error, 'WebDAV operation failed');
				}

				retryCount++;
				const retryError = toError(error, 'WebDAV operation failed');
				if (retryCount >= 3) {
					logger.error('WebDAV connection failed after retries', {
						error: retryError,
						retryCount,
					});
					throw new SyncRetryExhaustedError(undefined, retryError);
				}

				const backoff = getBackoffDelay(retryCount, 1000, 8000);
				logger.warn('Retrying WebDAV operation after transient error', {
					backoff,
					error: retryError,
					retryCount,
				});
				await breakableSleep(syncCancel, backoff);
				this.throwIfCancelled();
			}
		}
	}

	private readonly throwIfCancelled = () => {
		if (!this.isCancelled) return;
		logger.warn('WebDAV operation cancelled');
		throw new SyncCancelledError();
	};

	get app() {
		return this.plugin.app;
	}

	get webdav() {
		return this.options.webdav;
	}

	get vault() {
		return this.options.vault;
	}

	get remoteBaseDir() {
		return this.settings.remoteDir;
	}

	get settings() {
		return this.plugin.settings;
	}

	private getStateKey() {
		return getSyncStateKey({
			account: this.settings.account,
			remoteBaseDir: this.remoteBaseDir,
			serverUrl: this.settings.serverUrl,
			vaultName: this.vault.getName(),
		});
	}
}
