import type { App } from 'obsidian';
import type WebDAVSyncPlugin from '~';
import { PluginSettingTab } from 'obsidian';
import type { UserOptions } from '~/composable/glob-match';
import type { ToggleNumericSettingsField } from '~/types';
import AccountSettings from './account';
import CommonSettings from './common';
import ControlsSettings from './controls';
import DevelopmentSettings from './development';
import FilterSettings from './filter';

export * from './plugin-instance';

export enum ConflictStrategy {
	DiffMatchPatch = 'diffMatchPatch',
	LatestTimeStamp = 'latestTimestamp',
	KeepLocal = 'keepLocal',
	KeepRemote = 'keepRemote',
	Skip = 'skip',
}

export enum UnmergeableStrategy {
	LatestTimeStamp = 'latestTimestamp',
	KeepLocal = 'keepLocal',
	KeepRemote = 'keepRemote',
	Skip = 'skip',
}

export type GlobMatchOptions = {
	expr: string;
	options: UserOptions;
};

export type ConnectionType = 'webdav' | 'nextcloud';

/** 'full' = this device syncs. 'monitor' = read-only; only reports whether the
 * vault is in sync with the server (for devices where another tool, e.g. the
 * Nextcloud desktop client, does the actual syncing). */
export type OperatingMode = 'full' | 'monitor';

export type PluginSettings = {
	/** Which connection mode the settings UI presents. Default 'webdav'. */
	connectionType: ConnectionType;
	/** Whether this device syncs or just monitors. Default 'full'. Per-device. */
	operatingMode: OperatingMode;
	serverUrl: string;
	account: string;
	token: string;
	encryption: {
		enabled: boolean;
		value: string;
	};
	exhaustiveRemoteTraversal: boolean;
	remoteDir: string;
	showSyncStatusInNotificationOnMobile: boolean;
	useGitStyle: boolean;
	conflictStrategy: ConflictStrategy;
	unmergeableStrategy: UnmergeableStrategy;
	confirmBeforeSync: boolean;
	confirmBeforeDeleteInAutoSync: boolean;
	/** If a single sync would delete more than this many files (local + remote),
	 * ask the user to confirm first. 0 disables the guard. */
	deletionGuardThreshold: number;
	fastRealtimeSync: boolean;
	filterRules: {
		exclusionRules: Array<GlobMatchOptions>;
		inclusionRules: Array<GlobMatchOptions>;
	};
	skipLargeFiles: ToggleNumericSettingsField; // Value is max size
	realtimeSync: ToggleNumericSettingsField; // Value is delay
	maxWebDAVConcurrency: ToggleNumericSettingsField; // Value is max
	maxThroughputConcurrency: ToggleNumericSettingsField; // Value is max
	maxSyncTaskConcurrency: ToggleNumericSettingsField; // Value is max
	minWebDAVRequestInterval: ToggleNumericSettingsField; // Value is min
	startupSync: ToggleNumericSettingsField; // Value is delay
	scheduledSync: ToggleNumericSettingsField; // Value is interval
};

type TabId = 'connection' | 'sync' | 'advanced' | 'developer';

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'connection', label: 'Connection' },
	{ id: 'sync', label: 'Sync' },
	{ id: 'advanced', label: 'Advanced' },
	{ id: 'developer', label: 'Developer' },
];

export class SyncSettingTab extends PluginSettingTab {
	plugin: WebDAVSyncPlugin;
	accountSettings: AccountSettings;
	commonSettings: CommonSettings;
	filterSettings: FilterSettings;
	logSettings: DevelopmentSettings;
	controlsSettings: ControlsSettings;
	private activeTab: TabId = 'connection';

	constructor(app: App, plugin: WebDAVSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Dummy div — each sub-class gets a real container assigned in display().
		const dummy = document.createElement('div');
		this.accountSettings = new AccountSettings(this.app, this.plugin, this, dummy);
		this.commonSettings = new CommonSettings(this.app, this.plugin, this, dummy);
		this.controlsSettings = new ControlsSettings(this.app, this.plugin, this, dummy);
		this.filterSettings = new FilterSettings(this.app, this.plugin, this, dummy);
		this.logSettings = new DevelopmentSettings(this.app, this.plugin, this, dummy);
	}

	display() {
		this.containerEl.empty();

		// Tab navigation bar
		const nav = this.containerEl.createDiv({ cls: 'soliddav-tab-nav' });
		for (const { id, label } of TABS) {
			const btn = nav.createEl('button', {
				cls: 'soliddav-tab-btn',
				text: label,
			});
			if (this.activeTab === id) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				this.activeTab = id;
				this.display();
			});
		}

		// Content area — each sub-class renders into its own sub-div so that
		// their internal this.display() calls only clear their own region.
		const content = this.containerEl.createDiv({ cls: 'soliddav-tab-content' });

		switch (this.activeTab) {
			case 'connection': {
				const el = content.createDiv();
				this.accountSettings.setContainer(el);
				this.accountSettings.display();
				break;
			}
			case 'sync': {
				const el = content.createDiv();
				this.commonSettings.setContainer(el);
				this.commonSettings.display();
				break;
			}
			case 'advanced': {
				const perfEl = content.createDiv();
				this.controlsSettings.setContainer(perfEl);
				this.controlsSettings.display();
				const filterEl = content.createDiv();
				this.filterSettings.setContainer(filterEl);
				this.filterSettings.display();
				break;
			}
			case 'developer': {
				const el = content.createDiv();
				this.logSettings.setContainer(el);
				this.logSettings.display();
				break;
			}
		}
	}
}
