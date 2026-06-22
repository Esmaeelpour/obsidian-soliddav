import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';

/**
 * Defense-in-depth: when a single sync would delete more files than the safety
 * limit, make the user explicitly confirm before anything is deleted. Dismissing
 * the modal (tapping outside, back, etc.) counts as Cancel — the safe default.
 */
export default class DeletionGuardModal extends Modal {
	private resolved = false;
	private resolver?: (proceed: boolean) => void;

	constructor(
		app: App,
		private readonly counts: { local: number; remote: number },
	) {
		super(app);
	}

	openAndWait(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	private finish(proceed: boolean) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolver?.(proceed);
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		const total = this.counts.local + this.counts.remote;
		this.setTitle('Confirm large deletion');
		contentEl.empty();
		contentEl.createEl('p', {
			cls: 'whitespace-pre-line',
			text:
				`This sync wants to delete ${total} file(s): ${this.counts.remote} on the ` +
				`server and ${this.counts.local} on this device.\n\n` +
				`That is more than the safety limit. Continue only if you intended these ` +
				`deletions — otherwise cancel and check your setup.`,
		});
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Cancel sync')
					.setCta()
					.onClick(() => this.finish(false)),
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText(`Delete ${total} file(s)`)
					.onClick(() => this.finish(true)),
			);
	}

	onClose() {
		// Dismissed without an explicit choice → cancel (never delete by accident).
		this.finish(false);
		this.contentEl.empty();
	}
}
