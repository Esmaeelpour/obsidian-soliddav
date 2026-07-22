import type { StatModel } from '~/types';
import parseXML from '~/composable/parse-xml';
import requestUrl from '~/utils/request-url';
import {
	buildDirectoryUrl,
	buildStripPrefixes,
	convertToFileStat,
	isRemoteInternalPath,
	isSuccessStatus,
	normalizePath,
	type WebDAVResponseItem,
} from './api';

/**
 * RFC 6578 WebDAV Collection Synchronization: instead of walking the whole
 * remote tree every sync (what getDirectoryContents/traverseWebDAV do), a
 * compliant server can return just what changed since an opaque token this
 * client stored from the previous call — turning an O(tree size) PROPFIND
 * walk into O(changes). Support is rare outside CalDAV/CardDAV, so this is
 * strictly opt-in: any non-conforming response permanently (for this
 * session, per server+dir) falls back to the existing full walk. Nothing
 * here can make a sync less correct than the fallback it replaces — on any
 * doubt, this reports "unsupported" and the caller re-walks fully.
 */

const SYNC_LEVEL = 'infinite';

function syncCollectionBody(token: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>${token}</d:sync-token>
  <d:sync-level>${SYNC_LEVEL}</d:sync-level>
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getetag/>
  </d:prop>
</d:sync-collection>`;
}

export type SyncCollectionChange = {
	/** Remote-root-relative path (same convention as StatModel.path elsewhere —
	 * NOT yet made relative to the configured remote sync directory; the
	 * caller does that the same way traverse.ts does for the PROPFIND path). */
	path: string;
	/** undefined means the resource was removed (a bare 404 <status> entry). */
	stat: StatModel | undefined;
};

export type SyncCollectionResult =
	| { supported: false }
	| { supported: true; changes: Array<SyncCollectionChange>; nextSyncToken: string };

/** Servers (keyed by endpoint+dir) confirmed this session not to support
 * sync-collection — never retried until the plugin reloads. */
const unsupported = new Set<string>();

function serverKey(endpoint: string, remoteDir: string): string {
	return `${endpoint}::${remoteDir}`;
}

import kvStore from '~/storage/kv.store';

const syncTokenCache = new Map<string, string>();

function tokenStorageKey(endpoint: string, remoteDir: string): string {
	return `soliddav-sync-token::${serverKey(endpoint, remoteDir)}`;
}

export function getStoredSyncToken(endpoint: string, remoteDir: string): string {
	const key = tokenStorageKey(endpoint, remoteDir);
	if (syncTokenCache.has(key)) return syncTokenCache.get(key) ?? '';

	try {
		const val = localStorage.getItem(key) ?? '';
		if (val) syncTokenCache.set(key, val);
		return val;
	} catch {
		return '';
	}
}

function setStoredSyncToken(endpoint: string, remoteDir: string, token: string): void {
	const key = tokenStorageKey(endpoint, remoteDir);
	syncTokenCache.set(key, token);
	try {
		localStorage.setItem(key, token);
		void kvStore.set(key, token);
	} catch {
		/* best-effort; a failed write just means the next sync re-derives it */
	}
}

export function clearStoredSyncToken(endpoint: string, remoteDir: string): void {
	const key = tokenStorageKey(endpoint, remoteDir);
	syncTokenCache.delete(key);
	try {
		localStorage.removeItem(key);
		void kvStore.remove(key);
	} catch {
		/* ignore */
	}
}

function isRemovedResponse(item: WebDAVResponseItem): boolean {
	// RFC 6578 example shape for a removed member: a bare <status> child of
	// <response>, no <propstat> at all.
	return !item.propstat && typeof item.status === 'string' && !isSuccessStatus(item.status);
}

/**
 * Attempts one sync-collection REPORT. Returns `{ supported: false }` for
 * anything short of a well-formed 207 response with a sync-token — including
 * a rejected/expired token, which also clears the stored token so the next
 * attempt starts clean rather than retrying the same bad token forever.
 */
export async function trySyncCollection(
	endpoint: string,
	token: string,
	remoteDir: string,
): Promise<SyncCollectionResult> {
	const key = serverKey(endpoint, remoteDir);
	if (unsupported.has(key)) return { supported: false };

	const syncToken = getStoredSyncToken(endpoint, remoteDir);
	const url = buildDirectoryUrl(endpoint, remoteDir);

	let response;
	try {
		response = await requestUrl({
			body: syncCollectionBody(syncToken),
			headers: {
				Authorization: `Basic ${token}`,
				'Content-Type': 'application/xml',
			},
			method: 'REPORT',
			throw: false,
			url,
		});
	} catch {
		// Network-level failure isn't evidence of no support — let the caller's
		// normal retry/traversal machinery handle it, don't blacklist the server.
		return { supported: false };
	}

	// A previously-valid token can be rejected (410 Gone / 403 Forbidden per
	// RFC 6578) if the server's change log rolled past it. Reset and let the
	// next sync re-establish a token via a fresh (full) sync-collection call,
	// rather than wedging on a token that will never be accepted again.
	if (response.status === 410 || response.status === 403) {
		clearStoredSyncToken(endpoint, remoteDir);
		return { supported: false };
	}

	if (response.status !== 207) {
		unsupported.add(key);
		return { supported: false };
	}

	let result: {
		multistatus: {
			response: WebDAVResponseItem | Array<WebDAVResponseItem>;
			'sync-token'?: string;
		};
	};
	try {
		result = parseXML(response.text);
	} catch {
		unsupported.add(key);
		return { supported: false };
	}

	const nextSyncToken = result.multistatus['sync-token'];
	if (typeof nextSyncToken !== 'string' || nextSyncToken.length === 0) {
		// No sync-token in the response at all means this server doesn't
		// actually implement sync-collection (some just ignore unknown REPORT
		// bodies and return an empty/plain multistatus).
		unsupported.add(key);
		return { supported: false };
	}

	const items = Array.isArray(result.multistatus.response)
		? result.multistatus.response
		: result.multistatus.response
			? [result.multistatus.response]
			: [];
	const stripPrefixes = buildStripPrefixes(endpoint).sort((a, b) => b.length - a.length);

	const changes: Array<SyncCollectionChange> = [];
	for (const item of items) {
		let path = normalizePath(item.href);
		for (const prefix of stripPrefixes)
			if (prefix !== '/' && path.startsWith(prefix)) {
				path = path.slice(prefix.length);
				break;
			}
		if (isRemoteInternalPath(path)) continue;

		if (isRemovedResponse(item)) {
			changes.push({ path, stat: undefined });
			continue;
		}
		const stat = convertToFileStat(stripPrefixes, item);
		if (stat) changes.push({ stat, path: stat.path });
	}

	setStoredSyncToken(endpoint, remoteDir, nextSyncToken);
	return { changes, nextSyncToken, supported: true };
}
