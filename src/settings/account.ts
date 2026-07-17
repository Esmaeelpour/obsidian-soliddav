import type { ButtonComponent, TextComponent } from 'obsidian';
import { Notice, SecretComponent, Setting } from 'obsidian';
import EncryptionReminderModal from '~/components/EncryptionReminderModal';
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal';
import t from '~/i18n';
import { normalizeBaseDir } from '~/platform/path';
import { applyNextcloudLogin, startNextcloudLogin } from '~/services/nextcloud-login';
import handleInput from '~/utils/handle-input';
import type { ConnectionType } from '.';
import BaseSettings from './settings.base';

export default class AccountSettings extends BaseSettings {
	display() {
		let remoteBaseDirText: TextComponent | undefined;
		this.containerEl.empty();

		// ---- Server & credentials -------------------------------------------
		const serverEl = this.makeSection('Server & credentials');

		// One-time onboarding: shown only until the connection is configured.
		if (!this.plugin.isAccountConfigured())
			new Setting(serverEl)
				.setName('Quick start')
				.setDesc(
					'1. Choose a Connection type below — Nextcloud for one-click browser ' +
						'login, or WebDAV for manual setup.\n' +
						'2. Connect — log in (Nextcloud), or enter your server URL, account ' +
						'and credential (WebDAV).\n' +
						'3. Set the Remote directory (the server folder to sync), then press ' +
						'Check connection.',
				)
				.setClass('whitespace-pre-line');

		new Setting(serverEl)
			.setName(t('settings.tips.name'))
			.setDesc(t('settings.tips.desc'))
			.setClass('whitespace-pre-line');

		new Setting(serverEl)
			.setName('Connection')
			.setDesc(
				this.plugin.isAccountConfigured()
					? `✓ Configured — account: ${this.plugin.settings.account}`
					: 'Not configured yet — fill in the fields below, then Check connection.',
			)
			.setHeading();

		this.displayModeSelector(serverEl);

		const isNextcloud = this.plugin.settings.connectionType === 'nextcloud';
		const loggedIn = isNextcloud && this.plugin.isAccountConfigured();

		// In Nextcloud mode, hide the URL field once logged in (it's managed for
		// you); the status line below shows the connection instead.
		if (!loggedIn)
			new Setting(serverEl)
				.setName(isNextcloud ? 'Nextcloud server URL' : t('settings.serverUrl.name'))
			.setDesc(
				isNextcloud
					? 'Just your Nextcloud base address. After you log in below, the full ' +
							'WebDAV path is filled in for you automatically.'
					: t('settings.serverUrl.desc'),
			)
			.addText((text) => {
				text
					.setPlaceholder(
						isNextcloud
							? 'https://cloud.example.com'
							: t('settings.serverUrl.placeholder'),
					)
					.setValue(this.plugin.settings.serverUrl);
				handleInput({
					field: 'serverUrl',
					plugin: this.plugin,
					processValue: (value) => {
						// Be forgiving: if the user omits the scheme, assume https://.
						const candidate = /^https?:\/\//i.test(value.trim())
							? value.trim()
							: `https://${value.trim()}`;
						let parsedUrl: URL;
						try {
							parsedUrl = new URL(candidate);
						} catch {
							return false;
						}
						if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;
						return parsedUrl.toString().replace(/\/+$/, '');
					},
					text,
				});
			});

		if (isNextcloud) {
			if (loggedIn) this.displayNextcloudStatus(serverEl);
			else this.displayNextcloudLogin(serverEl);
		} else {
			new Setting(serverEl)
				.setName(t('settings.account.name'))
				.setDesc(t('settings.account.desc'))
				.addText((text) => {
					text.setPlaceholder(t('settings.account.placeholder')).setValue(
						this.plugin.settings.account,
					);
					handleInput({
						field: 'account',
						plugin: this.plugin,
						processValue: (value) => value.trim(),
						text,
					});
				});

			new Setting(serverEl)
				.setName(t('settings.credential.name'))
				.setDesc(t('settings.credential.desc'))
				.addComponent((element) =>
					new SecretComponent(this.app, element)
						.setValue(this.plugin.settings.token)
						.onChange((token) => {
							if (this.plugin.settings.token !== token) {
								this.plugin.settings.token = token;
								void this.plugin.saveSettings();
							}
						}),
				);
		}

		this.displayCheckConnection(serverEl);

		// ---- Remote storage & security --------------------------------------
		const storageEl = this.makeSection('Remote storage & security');

		new Setting(storageEl)
			.setName(t('settings.remoteDir.name'))
			.setDesc(t('settings.remoteDir.desc'))
			.addText((text) => {
				remoteBaseDirText = text;
				text.setPlaceholder(t('settings.remoteDir.placeholder')).setValue(
					this.plugin.settings.remoteDir,
				);
				handleInput({
					field: 'remoteDir',
					plugin: this.plugin,
					processValue: (original) => normalizeBaseDir(original.trim()),
					text,
				});
			})
			.addButton((button) => {
				button.setIcon('folder').onClick(() => {
					if (!this.plugin.isAccountConfigured()) {
						new Notice(t('sync.error.accountNotConfigured'));
						return;
					}
					new SelectRemoteBaseDirModal(this.app, this.plugin, (path) => {
						if (path === this.plugin.settings.remoteDir) return;
						this.plugin.settings.remoteDir = path;
						remoteBaseDirText?.setValue(path);
						void this.plugin.saveSettings();
					}).open();
				});
			});

		new Setting(storageEl)
			.setName(t('settings.encryption.name'))
			.setDesc(t('settings.encryption.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.encryption.enabled);
				toggle.onChange((enabled) => {
					if (this.plugin.settings.encryption.enabled !== enabled) {
						this.plugin.settings.encryption.enabled = enabled;
						void this.plugin.saveSettings();
						new EncryptionReminderModal(
							this.plugin,
							enabled ? 'enabled' : 'disabled',
						).open();
						this.display();
					}
				});
			});

		// Only show the password field when encryption is actually on.
		if (this.plugin.settings.encryption.enabled)
			new Setting(storageEl)
				.setName('Encryption password')
				.setDesc('Password used to encrypt files before upload. Keep it safe — files cannot be recovered without it.')
				.addComponent((element) =>
					new SecretComponent(this.app, element)
						.setValue(this.plugin.settings.encryption.value)
						.onChange((value) => {
							if (this.plugin.settings.encryption.value !== value) {
								this.plugin.settings.encryption.value = value;
								void this.plugin.saveSettings();
							}
						}),
				);
	}

	private displayModeSelector(el: HTMLElement) {
		new Setting(el)
			.setName('Connection type')
			.setDesc(
				'Nextcloud: log in via your browser (SSO supported); account and credential ' +
					'are managed for you. WebDAV: enter account and credential manually.',
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption('webdav', 'WebDAV')
					.addOption('nextcloud', 'Nextcloud')
					.setValue(this.plugin.settings.connectionType)
					.onChange((value) => {
						this.plugin.settings.connectionType = value as ConnectionType;
						void this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private displayNextcloudStatus(el: HTMLElement) {
		const { account, serverUrl } = this.plugin.settings;
		let host = serverUrl;
		try {
			host = new URL(serverUrl).host;
		} catch {
			/* keep raw value */
		}
		new Setting(el)
			.setName('Nextcloud account')
			.setDesc(`Logged in as ${account} at ${host}.`)
			.addButton((button) =>
				button
					.setButtonText('Log in again')
					.onClick(() => void this.runNextcloudLogin(serverUrl, button)),
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Log out')
					.onClick(async () => {
						this.plugin.settings.account = '';
						this.plugin.settings.token = '';
						this.plugin.settings.serverUrl = '';
						await this.plugin.saveSettings();
						new Notice('Logged out of Nextcloud.');
						this.display();
					}),
			);
	}

	private displayNextcloudLogin(el: HTMLElement) {
		new Setting(el)
			.setName('Log in with Nextcloud')
			.setDesc(
				'Authorize in your browser (SSO supported). The WebDAV URL, account and ' +
					'credential are filled in automatically — you only need to choose a ' +
					'Remote directory below.',
			)
			.addButton((button) =>
				button
					.setCta()
					.setButtonText('Log in with Nextcloud')
					.onClick(() =>
						void this.runNextcloudLogin(
							this.plugin.settings.serverUrl?.trim() ?? '',
							button,
						),
					),
			);
	}

	private async runNextcloudLogin(raw: string, button: ButtonComponent) {
		if (!raw) {
			new Notice('Enter your Nextcloud server URL above first.');
			return;
		}
		button.setDisabled(true);
		button.setButtonText('Waiting for browser…');
		try {
			const handle = await startNextcloudLogin(raw);
			const login = await handle.result;
			await applyNextcloudLogin(this.app, this.plugin, login);
			new Notice(`Logged in to Nextcloud as ${login.loginName}.`);
			this.display();
		} catch (error) {
			new Notice(`Nextcloud login failed: ${(error as Error).message}`);
			button.setDisabled(false);
			button.setButtonText('Log in with Nextcloud');
		}
	}

	private displayCheckConnection(el: HTMLElement) {
		new Setting(el)
			.setName(t('settings.checkConnection.name'))
			.setDesc(t('settings.checkConnection.desc'))
			.addButton((button) => {
				button.setButtonText(t('settings.checkConnection.name')).onClick((event) => {
					const buttonEl = event.currentTarget;
					if (!(buttonEl instanceof HTMLElement)) return;
					void this.checkConnection(buttonEl);
				});
			});
	}

	private async checkConnection(buttonEl: HTMLElement) {
		buttonEl.classList.add('connection-button', 'loading');
		buttonEl.classList.remove('success', 'error');
		buttonEl.textContent = t('settings.checkConnection.name');
		try {
			const { success, error } = await this.plugin.webDAVService.checkWebDAVConnection();
			buttonEl.classList.remove('loading');
			if (success) {
				buttonEl.classList.add('success');
				buttonEl.textContent = t('settings.checkConnection.successButton');
				new Notice(t('settings.checkConnection.success'));
				return;
			}

			buttonEl.classList.add('error');
			buttonEl.textContent = t('settings.checkConnection.failureButton');
			const reason = error?.message?.trim();
			new Notice(
				reason
					? t('settings.checkConnection.failureWithReason', { reason })
					: t('settings.checkConnection.failure'),
			);
		} catch {
			buttonEl.classList.remove('loading');
			buttonEl.classList.add('error');
			buttonEl.textContent = t('settings.checkConnection.failureButton');
			new Notice(t('settings.checkConnection.failure'));
		}
	}
}
