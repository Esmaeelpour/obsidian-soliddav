import type { App } from 'obsidian';
import { requestUrl } from 'obsidian';
import type WebDAVSyncPlugin from '~';

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

const PENDING_LOGIN_KEY = 'soliddav-pending-nextcloud-login';

/**
 * Persisted alongside the in-memory polling loop below (not instead of it):
 * on Android, opening the system browser can suspend or even fully reload
 * Obsidian's WebView, which silently kills the in-memory poll loop and the
 * promise the Settings tab is awaiting — the login completes on Nextcloud's
 * side, but nothing in the app ever finds out. Persisting just enough to
 * resume the poll (see resumePendingNextcloudLogin) means returning to the
 * app can always pick the flow back up, even after a full reload.
 */
function persistPendingLogin(state: PendingLogin): void {
	try {
		localStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(state));
	} catch {
		/* best-effort */
	}
}

function readPendingLogin(): PendingLogin | undefined {
	try {
		const raw = localStorage.getItem(PENDING_LOGIN_KEY);
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

export function clearPendingNextcloudLogin(): void {
	try {
		localStorage.removeItem(PENDING_LOGIN_KEY);
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

/**
 * Checks for a login flow left pending by a previous app session (see the
 * class comment on persistPendingLogin) and, if Nextcloud has since recorded
 * the grant, returns it. Call this on plugin load and whenever the app
 * returns to the foreground on mobile — it's a single cheap request when
 * nothing is pending, so it's safe to call opportunistically and often.
 */
export async function resumePendingNextcloudLogin(): Promise<NextcloudLoginResult | undefined> {
	const pending = readPendingLogin();
	if (!pending) return undefined;
	if (Date.now() > pending.deadline) {
		clearPendingNextcloudLogin();
		return undefined;
	}
	try {
		const outcome = await pollOnce(pending.pollEndpoint, pending.token);
		if (outcome.status === 'pending') return undefined;
		clearPendingNextcloudLogin();
		return outcome.data;
	} catch {
		// Leave it persisted — a transient network error shouldn't drop a login
		// the user is actively waiting on; it'll be retried on the next check.
		return undefined;
	}
}

/**
 * Start the flow against a Nextcloud base URL (scheme+host derived from the URL
 * the user typed). Opens the browser and polls until access is granted.
 */
export async function startNextcloudLogin(rawBaseUrl: string): Promise<LoginFlowHandle> {
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

	persistPendingLogin({ deadline, pollEndpoint, token });

	// Open the browser for the user to authenticate + grant access.
	window.open(loginUrl, '_blank');

	let cancelled = false;
	const result = (async (): Promise<NextcloudLoginResult> => {
		try {
			while (Date.now() < deadline) {
				if (cancelled) throw new Error('Login cancelled.');
				await sleep(3000);
				if (cancelled) throw new Error('Login cancelled.');
				const outcome = await pollOnce(pollEndpoint, token);
				if (outcome.status === 'done') return outcome.data;
			}
			throw new Error('Login timed out. Please try again.');
		} finally {
			clearPendingNextcloudLogin();
		}
	})();

	return {
		cancel: () => {
			cancelled = true;
			clearPendingNextcloudLogin();
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
