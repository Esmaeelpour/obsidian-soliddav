import { Platform, Setting } from 'obsidian';
import t from '~/i18n';
import { ConflictStrategy, type OperatingMode, UnmergeableStrategy } from '.';
import generateSettingEntry, { UserInputType } from './generate-setting-entry';
import BaseSettings from './settings.base';

export default class CommonSettings extends BaseSettings {
	display() {
		this.containerEl.empty();

		// ---- Operating mode -------------------------------------------------
		new Setting(this.containerEl)
			.setName('Operating mode')
			.setDesc(
				'Full sync: this device uploads and downloads. Monitor only: read-only — ' +
					'it just shows whether your vault matches the server, for when another ' +
					'tool (e.g. the Nextcloud desktop client) does the actual syncing.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('full', 'Full sync')
					.addOption('monitor', 'Monitor only (read-only)')
					.setValue(this.plugin.settings.operatingMode)
					.onChange((value) => {
						this.plugin.settings.operatingMode = value as OperatingMode;
						void this.plugin.saveSettings();
					}),
			);

		// ---- Automatic sync -------------------------------------------------
		const autoSyncEl = this.makeSection('Automatic sync');

		generateSettingEntry({
			container: autoSyncEl,
			desc: t('settings.realtimeSync.desc'),
			field: this.plugin.settings.realtimeSync,
			name: t('settings.realtimeSync.name'),
			placeholder: t('settings.realtimeSync.placeholder'),
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Time,
		});

		new Setting(autoSyncEl)
			.setName(t('settings.fastRealtimeSync.name'))
			.setDesc(t('settings.fastRealtimeSync.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.fastRealtimeSync).onChange((value) => {
					this.plugin.settings.fastRealtimeSync = value;
					void this.plugin.saveSettings();
				}),
			);

		generateSettingEntry({
			container: autoSyncEl,
			desc: t('settings.startupSync.desc'),
			field: this.plugin.settings.startupSync,
			name: t('settings.startupSync.name'),
			placeholder: t('settings.startupSync.placeholder'),
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Time,
		});

		generateSettingEntry({
			container: autoSyncEl,
			desc: t('settings.scheduledSync.desc'),
			field: this.plugin.settings.scheduledSync,
			name: t('settings.scheduledSync.name'),
			onChange: () => {
				const service = this.plugin.syncSchedulerService;
				service.stopScheduledSync();
				service.startScheduledSync();
			},
			onToggle: (enabled) => {
				const service = this.plugin.syncSchedulerService;
				if (enabled) service.startScheduledSync();
				else service.stopScheduledSync();
			},
			placeholder: t('settings.scheduledSync.placeholder'),
			rejectZero: true,
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Time,
		});

		// ---- Conflict handling ----------------------------------------------
		const conflictEl = this.makeSection('Conflict handling');

		new Setting(conflictEl)
			.setName(t('settings.conflictStrategy.name'))
			.setDesc(t('settings.conflictStrategy.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						ConflictStrategy.DiffMatchPatch,
						t('settings.conflictStrategy.diffMatchPatch'),
					)
					.addOption(
						ConflictStrategy.LatestTimeStamp,
						t('settings.conflictStrategy.latestTimestamp'),
					)
					.addOption(ConflictStrategy.KeepLocal, t('settings.conflictStrategy.keepLocal'))
					.addOption(
						ConflictStrategy.KeepRemote,
						t('settings.conflictStrategy.keepRemote'),
					)
					.addOption(ConflictStrategy.Skip, t('settings.conflictStrategy.skip'))
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange((value) => {
						const originalValue = this.plugin.settings.conflictStrategy;
						const newValue = value as ConflictStrategy;
						if (newValue !== originalValue) {
							this.plugin.settings.conflictStrategy = newValue;
							void this.plugin.saveSettings();
							if (
								(originalValue === ConflictStrategy.DiffMatchPatch) !==
								(newValue === ConflictStrategy.DiffMatchPatch)
							)
								this.display();
						}
					}),
			);

		if (this.plugin.settings.conflictStrategy === ConflictStrategy.DiffMatchPatch)
			new Setting(conflictEl)
				.setName(t('settings.unmergeableStrategy.name'))
				.setDesc(t('settings.unmergeableStrategy.desc'))
				.addDropdown((dropdown) =>
					dropdown
						.addOption(
							UnmergeableStrategy.LatestTimeStamp,
							t('settings.conflictStrategy.latestTimestamp'),
						)
						.addOption(
							UnmergeableStrategy.KeepLocal,
							t('settings.conflictStrategy.keepLocal'),
						)
						.addOption(
							UnmergeableStrategy.KeepRemote,
							t('settings.conflictStrategy.keepRemote'),
						)
						.addOption(UnmergeableStrategy.Skip, t('settings.conflictStrategy.skip'))
						.setValue(this.plugin.settings.unmergeableStrategy)
						.onChange((value) => {
							this.plugin.settings.unmergeableStrategy = value as UnmergeableStrategy;
							void this.plugin.saveSettings();
						}),
				);

		new Setting(conflictEl)
			.setName(t('settings.useGitStyle.name'))
			.setDesc(t('settings.useGitStyle.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useGitStyle).onChange((value) => {
					this.plugin.settings.useGitStyle = value;
					void this.plugin.saveSettings();
				}),
			);

		// ---- Sync safety ----------------------------------------------------
		const safetyEl = this.makeSection('Sync safety');

		new Setting(safetyEl)
			.setName(t('settings.confirmBeforeSync.name'))
			.setDesc(t('settings.confirmBeforeSync.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmBeforeSync).onChange((value) => {
					this.plugin.settings.confirmBeforeSync = value;
					void this.plugin.saveSettings();
				}),
			);

		new Setting(safetyEl)
			.setName(t('settings.confirmBeforeDeleteInAutoSync.name'))
			.setDesc(t('settings.confirmBeforeDeleteInAutoSync.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmBeforeDeleteInAutoSync)
					.onChange((value) => {
						this.plugin.settings.confirmBeforeDeleteInAutoSync = value;
						void this.plugin.saveSettings();
					}),
			);

		new Setting(safetyEl)
			.setName('Deletion safety limit')
			.setDesc(
				'If a single sync would delete more than this many files (local + remote), ' +
					'pause and ask for confirmation first. 0 disables the guard.',
			)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.deletionGuardThreshold))
					.onChange((value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.deletionGuardThreshold =
							Number.isFinite(n) && n >= 0 ? n : 0;
						void this.plugin.saveSettings();
					}),
			);

		// ---- Status & notifications -----------------------------------------
		const statusEl = this.makeSection('Status & notifications');

		if (Platform.isMobile)
			// Mobile has no status bar — status rides on the ribbon icon; this only
			// controls the optional brief popup on success.
			new Setting(statusEl)
				.setName('Notify after every sync')
				.setDesc(
					'Pop a notice after every sync, including ones that changed nothing. ' +
						'Leave this OFF to be notified only when the server actually updates ' +
						'your vault (and on failures) — no "up to date" spam.',
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.showSyncStatusInNotificationOnMobile)
						.onChange((value) => {
							this.plugin.settings.showSyncStatusInNotificationOnMobile = value;
							this.plugin.observabilityService.syncMobileNoticeWithSettings();
							void this.plugin.saveSettings();
						}),
				);
		else
			// Desktop: status is always in the status bar; no notification toggle.
			new Setting(statusEl)
				.setName('Sync status')
				.setDesc('Shown in the status bar at the bottom of the window.');

		// ---- Advanced -------------------------------------------------------
		const advancedEl = this.makeSection('Advanced', false);

		new Setting(advancedEl)
			.setName(t('settings.exhaustiveRemoteTraversal.name'))
			.setDesc(t('settings.exhaustiveRemoteTraversal.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.exhaustiveRemoteTraversal)
					.onChange((value) => {
						this.plugin.settings.exhaustiveRemoteTraversal = value;
						void this.plugin.saveSettings();
					}),
			);
	}
}
