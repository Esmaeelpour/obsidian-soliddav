import type { App } from 'obsidian';
import { requestUrl } from 'obsidian';
import type WebDAVSyncPlugin from '~';
import logger from '~/utils/logger';

/**
 * Nextcloud "Login Flow v2" — the same browser-grant flow the official Nextcloud
 * clients use. The user authenticates in their browser (SSO included) and grants
 * access; Nextcloud then hands back an auto-generated app password. This removes
 * the need to create app passwords manually (which is impossible to reach in the
 * UI for some SSO setups).
 *
 * Docs: https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
 */

export interface NextcloudLoginResult {
	/** Nextcloud base URL, e.g. https://cloud.example.com */
	server: string;
	loginName: string;
	appPassword: string;
}

interface LoginFlowInit {
	login: string;
	poll: { token: string; endpoint: string };
}

/** Force a server-returned URL onto the user's origin. Nextcloud behind a reverse
 * proxy often returns http:// or the internal host in the flow URLs; we trust the
 * scheme/host the user actually connects to instead. */
function rebaseUrl(rawUrl: string, origin: string): string {
	try {
		const parsed = new URL(rawUrl);
		const target = new URL(origin);
		parsed.protocol = target.protocol;
		parsed.host = target.host;
		return parsed.toString();
	} catch {
		return rawUrl;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LoginFlowHandle {
	/** Resolves once the user grants access (or rejects on error/timeout/cancel). */
	result: Promise<NextcloudLoginResult>;
	/** The URL opened in the browser, in case it needs to be shown/re-opened. */
	loginUrl: string;
	cancel: () => void;
}

type PendingLogin = {
	pollEndpoint: string;
	token: string;
	/** Epoch ms; matches the in-memory loop's own 10-minute budget. */
	deadline: number;
};

/** Thrown by the in-memory loop when another path (the resume check or the
 * manual "complete login" button) already consumed the one-shot poll token.
 * runNextcloudLogin treats it as a non-error so no spurious "timed out"
 * notice appears after a login that actually succeeded elsewhere. */
export const LOGIN_COMPLETED_ELSEWHERE = '__nextcloud_login_completed_elsewhere__';

function getPendingLoginKey(app: App): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
	const id = (app as any).appId || app.vault.getName();
	return `soliddav-pending-nextcloud-login-${id}`;
}

/**
 * Persisted alongside the in-memory polling loop below (not instead of it):
 * on Android, opening the system browser can suspend or even fully reload
 * Obsidian's WebView, which silently kills the in-memory poll loop and the
 * promise the Settings tab is awaiting — the login completes on Nextcloud's
 * side, but nothing in the app ever finds out. Persisting just enough to
 * resume the poll (see resumePendingNextcloudLogin) means returning to the
 * app can always pick the flow back up, even after a full reload.
 */
function persistPendingLogin(app: App, state: PendingLogin): void {
	try {
		localStorage.setItem(getPendingLoginKey(app), JSON.stringify(state));
	} catch {
		/* best-effort */
	}
}

function readPendingLogin(app: App): PendingLogin | undefined {
	try {
		const raw = localStorage.getItem(getPendingLoginKey(app));
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as Partial<PendingLogin>;
		if (
			typeof parsed.pollEndpoint !== 'string' ||
			typeof parsed.token !== 'string' ||
			typeof parsed.deadline !== 'number'
		)
			return undefined;
		return parsed as PendingLogin;
	} catch {
		return undefined;
	}
}

export function clearPendingNextcloudLogin(app: App): void {
	try {
		localStorage.removeItem(getPendingLoginKey(app));
	} catch {
		/* ignore */
	}
}

async function pollOnce(
	pollEndpoint: string,
	token: string,
): Promise<{ status: 'pending' } | { status: 'done'; data: NextcloudLoginResult }> {
	const pollRes = await requestUrl({
		body: `token=${encodeURIComponent(token)}`,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		method: 'POST',
		throw: false,
		url: pollEndpoint,
	});
	if (pollRes.status === 200) {
		const data = pollRes.json as NextcloudLoginResult;
		if (!data.appPassword || !data.loginName || !data.server)
			throw new Error('Nextcloud returned an incomplete login response.');
		return { data, status: 'done' };
	}
	// 404 = still waiting for the user; anything else is a real error.
	if (pollRes.status !== 404) throw new Error(`Login polling failed (HTTP ${pollRes.status}).`);
	return { status: 'pending' };
}

/** Whether a login started in this or a previous session is still awaiting the
 * user's browser grant. Drives the manual "complete login" affordance in the
 * settings UI. Expires stale entries as a side effect. */
export function hasPendingNextcloudLogin(app: App): boolean {
	const pending = readPendingLogin(app);
	if (!pending) return false;
	if (Date.now() > pending.deadline) {
		clearPendingNextcloudLogin(app);
		return false;
	}
	return true;
}

export type CompleteLoginOutcome =
	| { status: 'none' }
	| { status: 'pending' }
	| { status: 'done'; login: NextcloudLoginResult }
	| { status: 'error'; message: string };

/**
 * Polls the pending login exactly once and reports the outcome. This is the
 * single, deterministic completion path — it does NOT depend on the in-memory
 * loop, background timers, or lifecycle events surviving (all unreliable on
 * mobile, where opening the browser can freeze or reload the WebView). Called
 * both automatically (plugin load / app-resume) and manually (the settings
 * "complete login" button), and surfaces real errors instead of swallowing
 * them so a failing sign-in is diagnosable.
 */
export async function completePendingNextcloudLoginNow(app: App): Promise<CompleteLoginOutcome> {
	const pending = readPendingLogin(app);
	if (!pending) return { status: 'none' };
	if (Date.now() > pending.deadline) {
		clearPendingNextcloudLogin(app);
		return { status: 'none' };
	}
	try {
		const outcome = await pollOnce(pending.pollEndpoint, pending.token);
		if (outcome.status === 'pending') return { status: 'pending' };
		clearPendingNextcloudLogin(app);
		return { login: outcome.data, status: 'done' };
	} catch (error) {
		return { message: (error as Error).message, status: 'error' };
	}
}

/**
 * Checks for a login flow left pending by a previous app session (see the
 * comment on persistPendingLogin) and, if Nextcloud has since recorded the
 * grant, returns it. Called on plugin load and on every mobile app-resume —
 * a cheap no-op when nothing is pending, so it's safe to call often. Silent
 * (returns undefined) unless a grant is actually ready.
 */
export async function resumePendingNextcloudLogin(app: App): Promise<NextcloudLoginResult | undefined> {
	const outcome = await completePendingNextcloudLoginNow(app);
	return outcome.status === 'done' ? outcome.login : undefined;
}

/**
 * Start the flow against a Nextcloud base URL (scheme+host derived from the URL
 * the user typed). Opens the browser and polls until access is granted.
 */
export async function startNextcloudLogin(app: App, rawBaseUrl: string): Promise<LoginFlowHandle> {
	// Tolerate a missing scheme (e.g. "cloud.example.com").
	const withScheme = /^https?:\/\//i.test(rawBaseUrl.trim())
		? rawBaseUrl.trim()
		: `https://${rawBaseUrl.trim()}`;
	const origin = new URL(withScheme).origin;

	const initRes = await requestUrl({
		headers: { 'User-Agent': 'Obsidian WebDAV Sync' },
		method: 'POST',
		throw: false,
		url: `${origin}/index.php/login/v2`,
	});
	if (initRes.status !== 200) {
		throw new Error(
			`Could not start Nextcloud login (HTTP ${initRes.status}). Is "${origin}" a Nextcloud server?`,
		);
	}
	const init = initRes.json as LoginFlowInit;
	const loginUrl = rebaseUrl(init.login, origin);
	const pollEndpoint = rebaseUrl(init.poll.endpoint, origin);
	const token = init.poll.token;
	const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes

	persistPendingLogin(app, { deadline, pollEndpoint, token });

	// Open the browser for the user to authenticate + grant access.
	window.open(loginUrl, '_blank');

	let cancelled = false;
	const result = (async (): Promise<NextcloudLoginResult> => {
		while (Date.now() < deadline) {
			if (cancelled) throw new Error('Login cancelled.');
			await sleep(3000);
			if (cancelled) throw new Error('Login cancelled.');

			// Another path (resume check or the manual button) may have already
			// consumed the one-shot token and cleared the pending state — stop
			// quietly rather than looping to a spurious "timed out" error.
			if (!readPendingLogin(app)) throw new Error(LOGIN_COMPLETED_ELSEWHERE);

			try {
				const outcome = await pollOnce(pollEndpoint, token);
				if (outcome.status === 'done') {
					clearPendingNextcloudLogin(app);
					return outcome.data;
				}
			} catch (error) {
				// A transient network blip mid-poll shouldn't abort the whole login
				// (mobile connections drop constantly) — keep polling until the
				// deadline; the manual button is the user's escape hatch otherwise.
				logger.warn('Nextcloud login poll failed, will retry', error);
			}
		}
		throw new Error('Login timed out. Please try again.');
	})();

	return {
		cancel: () => {
			cancelled = true;
			clearPendingNextcloudLogin(app);
		},
		loginUrl,
		result,
	};
}

/** Build the files WebDAV URL Nextcloud expects from a login result. */
export function webdavUrlFromLogin(result: NextcloudLoginResult): string {
	const base = result.server.replace(/\/+$/, '');
	return `${base}/remote.php/dav/files/${encodeURIComponent(result.loginName)}/`;
}

/** Shared by the Settings-tab button flow and resumePendingNextcloudLogin's
 * caller, so a login recovered after an app restart is applied identically
 * to one completed in the same session. */
export async function applyNextcloudLogin(
	app: App,
	plugin: WebDAVSyncPlugin,
	login: NextcloudLoginResult,
): Promise<void> {
	// The credential is kept in Obsidian's secret storage; settings.token holds
	// only the id used to look it up (id must be lowercase alphanumeric/dashes).
	const secretId = 'webdav-sync-credential';
	app.secretStorage.setSecret(secretId, login.appPassword);
	plugin.settings.serverUrl = webdavUrlFromLogin(login).replace(/\/+$/, '');
	plugin.settings.account = login.loginName;
	plugin.settings.token = secretId;
	await plugin.saveSettings();
}
