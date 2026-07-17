import { Setting } from 'obsidian';
import applyConcurrencySettings from '~/composable/apply-concurrency-settings';
import t from '~/i18n';
import generateSettingEntry, { UserInputType } from './generate-setting-entry';
import BaseSettings from './settings.base';

export default class ControlsSettings extends BaseSettings {
	display() {
		this.containerEl.empty();

		const perfEl = this.makeSection(t('settings.sections.control'));

		generateSettingEntry({
			container: perfEl,
			desc: t('settings.skipLargeFiles.desc'),
			field: this.plugin.settings.skipLargeFiles,
			name: t('settings.skipLargeFiles.name'),
			placeholder: t('settings.skipLargeFiles.placeholder'),
			rejectZero: true,
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.FileSize,
		});

		generateSettingEntry({
			container: perfEl,
			desc: t('settings.maxWebDAVConcurrency.desc'),
			field: this.plugin.settings.maxWebDAVConcurrency,
			name: t('settings.maxWebDAVConcurrency.name'),
			onChange: () => applyConcurrencySettings(this.plugin.settings),
			onToggle: () => applyConcurrencySettings(this.plugin.settings),
			placeholder: t('settings.maxWebDAVConcurrency.placeholder'),
			rejectZero: true,
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Number,
		});

		generateSettingEntry({
			container: perfEl,
			desc: t('settings.maxSyncTaskConcurrency.desc'),
			field: this.plugin.settings.maxSyncTaskConcurrency,
			name: t('settings.maxSyncTaskConcurrency.name'),
			placeholder: t('settings.maxSyncTaskConcurrency.placeholder'),
			rejectZero: true,
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Number,
		});

		generateSettingEntry({
			container: perfEl,
			desc: t('settings.minWebDAVRequestInterval.desc'),
			field: this.plugin.settings.minWebDAVRequestInterval,
			name: t('settings.minWebDAVRequestInterval.name'),
			onChange: () => applyConcurrencySettings(this.plugin.settings),
			onToggle: () => applyConcurrencySettings(this.plugin.settings),
			placeholder: t('settings.minWebDAVRequestInterval.placeholder'),
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.Time,
		});

		generateSettingEntry({
			container: perfEl,
			desc: t('settings.maxThroughputConcurrency.desc'),
			field: this.plugin.settings.maxThroughputConcurrency,
			name: t('settings.maxThroughputConcurrency.name'),
			placeholder: t('settings.maxThroughputConcurrency.placeholder'),
			rejectZero: true,
			saveSettings: this.plugin.saveSettings,
			type: UserInputType.FileSize,
		});
	}
}
