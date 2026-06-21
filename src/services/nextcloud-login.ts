import { requestUrl } from 'obsidian';

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
		url: `${origin}/index.php/login/v2`,
		method: 'POST',
		headers: { 'User-Agent': 'Obsidian WebDAV Sync' },
		throw: false,
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

	// Open the browser for the user to authenticate + grant access.
	window.open(loginUrl, '_blank');

	let cancelled = false;
	const result = (async (): Promise<NextcloudLoginResult> => {
		const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes
		while (Date.now() < deadline) {
			if (cancelled) throw new Error('Login cancelled.');
			await sleep(3000);
			if (cancelled) throw new Error('Login cancelled.');
			const pollRes = await requestUrl({
				url: pollEndpoint,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `token=${encodeURIComponent(token)}`,
				throw: false,
			});
			if (pollRes.status === 200) {
				const data = pollRes.json as NextcloudLoginResult;
				if (!data.appPassword || !data.loginName || !data.server) {
					throw new Error('Nextcloud returned an incomplete login response.');
				}
				return data;
			}
			// 404 = still waiting for the user; anything else is a real error.
			if (pollRes.status !== 404) {
				throw new Error(`Login polling failed (HTTP ${pollRes.status}).`);
			}
		}
		throw new Error('Login timed out. Please try again.');
	})();

	return {
		cancel: () => {
			cancelled = true;
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
