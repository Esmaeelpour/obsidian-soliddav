import type { App } from 'obsidian';
import type WebDAVSyncPlugin from '~';
import type { SyncSettingTab } from '.';

export default abstract class BaseSettings {
	constructor(
		protected app: App,
		protected plugin: WebDAVSyncPlugin,
		protected settings: SyncSettingTab,
		protected containerEl: HTMLElement,
	) {}

	setContainer(el: HTMLElement) {
		this.containerEl = el;
	}

	protected makeSection(title: string, open = true): HTMLElement {
		const details = this.containerEl.createEl('details', { cls: 'soliddav-section' });
		if (open) details.open = true;
		const summary = details.createEl('summary', { cls: 'soliddav-section-summary' });
		summary.createSpan({ text: title });
		return details.createDiv({ cls: 'soliddav-section-body' });
	}

	abstract display(): void;
}
