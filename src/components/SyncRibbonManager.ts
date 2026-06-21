import { setIcon, setTooltip } from 'obsidian';
import type WebDAVSyncPlugin from '~';
import t from '~/i18n';
import launchManualSync from '~/utils/launch-manual-sync';

/**
 * A single ribbon button that doubles as the status indicator. Tapping it starts
 * a sync, or — if one is already running — shows its progress (it never cancels,
 * to avoid accidentally stopping a background sync). The icon reflects state (no
 * animation, which is unreliable on mobile):
 *   - ready/idle  → refresh icon
 *   - syncing     → loader icon (tap for progress; stop is inside the progress view)
 *   - last failed → alert icon (until the next success)
 */
export default class SyncRibbonManager {
	private readonly ribbonEl: HTMLElement;
	private hasError = false;
	private statusTooltip = t('sync.startButton');

	constructor(private readonly plugin: WebDAVSyncPlugin) {
		this.ribbonEl = this.plugin.addRibbonIcon('refresh-ccw', t('sync.startButton'), () => {
			// Always launch (or show progress if already syncing) — never cancel.
			launchManualSync(this.plugin);
		});
		this.update();
	}

	/** Latest status text — shown as the button's label/tooltip when idle. */
	setStatusTooltip(tooltip: string) {
		this.statusTooltip = tooltip;
		if (!this.plugin.isSyncing) setTooltip(this.ribbonEl, tooltip);
	}

	/** Mark the last sync as failed (cleared on next success/sync). */
	setError(hasError: boolean) {
		this.hasError = hasError;
		this.update();
	}

	update() {
		if (this.plugin.isSyncing) {
			setIcon(this.ribbonEl, 'loader-2');
			setTooltip(this.ribbonEl, 'Syncing… (tap for progress)');
			this.ribbonEl.removeClass('webdav-sync-error');
			return;
		}
		setIcon(this.ribbonEl, this.hasError ? 'alert-triangle' : 'refresh-ccw');
		setTooltip(this.ribbonEl, this.hasError ? 'Sync failed — tap to retry' : this.statusTooltip);
		this.ribbonEl.toggleClass('webdav-sync-error', this.hasError);
	}
}
