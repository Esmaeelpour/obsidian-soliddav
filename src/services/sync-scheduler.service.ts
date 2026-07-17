import type { TAbstractFile } from 'obsidian';
import type WebDAVSyncPlugin from '~';
import { Platform } from 'obsidian';
import type { SyncTrigger } from '~/events';
import { syncRun } from '~/events';
import { noteLocalCreateOrModify, noteLocalDelete, noteLocalRename } from '~/fs/vault/local-index';
import { SyncRunKind } from '~/types';
import { buildRules, needIncludeFromGlobRules } from '~/utils/glob-match';
import waitUntil from '~/utils/wait-until';
import type {
	default as SyncExecutorService,
	SyncExecutionRequest,
	SyncOptions,
} from './sync-executor.service';

type SyncRequest = {
	requestedAt: number;
	source: SyncTrigger;
	resolve: (value: boolean) => void;
	reject: (reason?: unknown) => void;
} & SyncOptions;

/** How often monitor mode re-checks in the background (ms). */
const MONITOR_POLL_MS = 30_000;
/** Debounce after an edit before monitor mode re-checks (ms). */
const MONITOR_EDIT_DEBOUNCE_MS = 2500;
/** Minimum gap before an app-resume triggers a sync (ms), so quickly
 * switching in and out of the app doesn't spam the server. */
const RESUME_MIN_GAP_MS = 30_000;

export default class SyncSchedulerService {
	private readonly pendingRequests: Array<SyncRequest> = [];
	private isFlushing = false;
	private isScheduling = false;
	private realtimeSyncTimer?: number;
	private scheduledSyncTimer?: number;
	private startupSyncTimer?: number;
	private lastFlushEndedAt = 0;

	constructor(
		private readonly plugin: WebDAVSyncPlugin,
		private readonly syncExecutor: SyncExecutorService,
	) {}

	get settings() {
		return this.plugin.settings;
	}

	requestSync(options: SyncOptions & { source: SyncTrigger }): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			this.pendingRequests.push({
				...options,
				reject,
				requestedAt: Date.now(),
				resolve,
			});
			void this.scheduleFlush();
		});
	}

	start() {
		const monitor = this.settings.operatingMode === 'monitor';

		// Start periodic sync (full) / status poll (monitor) immediately at load,
		// independently of the startup sync — so a slow/interrupted startup sync
		// can never prevent the scheduled one from running.
		if (this.settings.scheduledSync.enabled) this.startScheduledSync();
		else if (monitor) this.startMonitorPoll();

		/* Mobile: sync when the app returns to the foreground. Timers freeze while
		 * the app is suspended, so without this the vault sits stale until the
		 * next edit or a scheduled interval eventually fires — the main reason
		 * the phone feels less fresh than the desktop, which never sleeps.
		 * Gated to setups that already opted into some form of automatic sync. */
		if (Platform.isMobile)
			this.plugin.registerDomEvent(document, 'visibilitychange', () => {
				if (document.visibilityState !== 'visible') return;

				// Opening the system browser for a Nextcloud login can suspend or
				// reload the WebView, dropping the in-memory poll the Settings tab
				// was awaiting. Cheap (one no-op localStorage read) when nothing is
				// pending, so it's fine to check on every resume.
				void this.plugin.checkPendingNextcloudLogin();

				const { realtimeSync, scheduledSync, startupSync, operatingMode } = this.settings;
				const autoSyncEnabled =
					realtimeSync.enabled ||
					scheduledSync.enabled ||
					startupSync.enabled ||
					operatingMode === 'monitor';
				if (!autoSyncEnabled || this.plugin.isSyncing) return;
				if (Date.now() - this.lastFlushEndedAt < RESUME_MIN_GAP_MS) return;
				void this.requestSync({ runKind: SyncRunKind.normal, source: 'interval' });
			});

		// https://forum.obsidian.md/t/dont-dispatch-create-event-on-startup/50022/3
		this.plugin.app.workspace.onLayoutReady(() => {
			this.plugin.registerEvent(this.plugin.app.vault.on('create', this.onChange));
			this.plugin.registerEvent(this.plugin.app.vault.on('delete', this.onChange));
			this.plugin.registerEvent(this.plugin.app.vault.on('modify', this.onChange));
			this.plugin.registerEvent(this.plugin.app.vault.on('rename', this.onChange));

			/* Keep the local-index cache (fs/vault/local-index.ts) warm, independent
			 * of whether realtime sync is even enabled — it's also read by any
			 * `fast` run, and staying warm here means the first fast sync after a
			 * normal one doesn't eat a full walk just to catch up on one edit. */
			this.plugin.registerEvent(
				this.plugin.app.vault.on('create', (file) =>
					void noteLocalCreateOrModify(this.plugin.app.vault, file.path),
				),
			);
			this.plugin.registerEvent(
				this.plugin.app.vault.on('modify', (file) =>
					void noteLocalCreateOrModify(this.plugin.app.vault, file.path),
				),
			);
			this.plugin.registerEvent(
				this.plugin.app.vault.on('delete', (file) => noteLocalDelete(file.path)),
			);
			this.plugin.registerEvent(
				this.plugin.app.vault.on('rename', (file, oldPath) =>
					void noteLocalRename(this.plugin.app.vault, oldPath, file.path),
				),
			);

			// Run the startup sync / initial check only once the workspace is ready.
			// On mobile the vault/credential store may not be ready at onload, so a
			// 0ms timer would fire too early and silently no-op. Floor the delay.
			if (this.settings.startupSync.enabled || monitor) {
				const delay = this.settings.startupSync.enabled
					? Math.max(this.settings.startupSync.value, 1500)
					: 2000;
				this.startupSyncTimer = window.setTimeout(
					() =>
						void this.requestSync({
							runKind: SyncRunKind.normal,
							source: 'startup',
						}),
					delay,
				);
			}
		});
	}

	unload() {
		while (this.pendingRequests.length > 0) {
			const request = this.pendingRequests.shift();
			request?.resolve(false);
		}
		if (this.realtimeSyncTimer) {
			window.clearTimeout(this.realtimeSyncTimer);
			this.realtimeSyncTimer = undefined;
		}
		if (this.startupSyncTimer) {
			window.clearTimeout(this.startupSyncTimer);
			this.startupSyncTimer = undefined;
		}
		this.stopScheduledSync();
	}

	startScheduledSync() {
		if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
		this.scheduledSyncTimer = window.setInterval(
			() =>
				void this.requestSync({
					runKind: SyncRunKind.normal,
					source: 'interval',
				}),
			this.settings.scheduledSync.value,
		);
	}

	startMonitorPoll() {
		if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
		this.scheduledSyncTimer = window.setInterval(
			() => void this.requestSync({ runKind: SyncRunKind.normal, source: 'interval' }),
			MONITOR_POLL_MS,
		);
	}

	stopScheduledSync() {
		if (this.scheduledSyncTimer) {
			window.clearInterval(this.scheduledSyncTimer);
			this.scheduledSyncTimer = undefined;
		}
	}

	private readonly onChange = (file: TAbstractFile, old?: string) => {
		if (syncRun()?.stage === 'executing') return;
		const { fastRealtimeSync, realtimeSync, filterRules } = this.settings;
		const monitor = this.settings.operatingMode === 'monitor';
		// Monitor mode re-checks after any edit (so status stays live); full sync
		// only does so when Real-time sync is enabled.
		if (!monitor && !realtimeSync.enabled) return;

		const exclusions = buildRules(filterRules.exclusionRules);
		const inclusions = buildRules(filterRules.inclusionRules);
		if (
			!needIncludeFromGlobRules(file.path, inclusions, exclusions) &&
			!(old && needIncludeFromGlobRules(old, inclusions, exclusions))
		)
			return;

		if (this.realtimeSyncTimer) window.clearTimeout(this.realtimeSyncTimer);
		this.realtimeSyncTimer = window.setTimeout(
			() =>
				void this.requestSync({
					runKind: !monitor && fastRealtimeSync ? SyncRunKind.fast : SyncRunKind.normal,
					source: 'realtime',
				}),
			monitor ? MONITOR_EDIT_DEBOUNCE_MS : this.settings.realtimeSync.value,
		);
	};

	private async scheduleFlush() {
		if (this.pendingRequests.length === 0 || this.isScheduling) return;

		this.isScheduling = true;
		if (this.isFlushing || this.plugin.isSyncing)
			await waitUntil(() => !this.isFlushing && !this.plugin.isSyncing);

		void this.flush();
		this.isScheduling = false;
	}

	private reduceBatch(batch: Array<SyncRequest>): SyncExecutionRequest {
		const runKind = batch.some((request) => request.runKind === SyncRunKind.normal)
			? SyncRunKind.normal
			: SyncRunKind.fast;

		let trigger: SyncTrigger = 'realtime';
		if (batch.some((request) => request.source === 'manual')) trigger = 'manual';
		else if (batch.some((request) => request.source === 'startup')) trigger = 'startup';
		else if (batch.some((request) => request.source === 'interval')) trigger = 'interval';

		return {
			queuedAt: Date.now(),
			runId: crypto.randomUUID(),
			runKind,
			sources: [...new Set(batch.map((request) => request.source))],
			trigger,
		};
	}

	private async flush() {
		this.isFlushing = true;
		const batch = this.pendingRequests.splice(0, this.pendingRequests.length);
		try {
			const result = await this.syncExecutor.executeSync(this.reduceBatch(batch));
			for (const request of batch) request.resolve(result.executed);
		} catch (error) {
			for (const request of batch) request.reject(error);
		} finally {
			this.isFlushing = false;
			this.lastFlushEndedAt = Date.now();
		}
	}
}
