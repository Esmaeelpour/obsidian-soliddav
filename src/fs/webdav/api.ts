import type { DAVResult } from 'webdav';
import type { StatModel } from '~/types';
import parseXML from '~/composable/parse-xml';
import { normalizeRemotePath } from '~/platform/path';
import { isNil } from '~/utils/fns';
import isRetryableError from '~/utils/is-retryable-error';
import logger from '~/utils/logger';
import requestUrl from '~/utils/request-url';
import sleep from '~/utils/sleep';

type WebDAVProp = {
	displayname?: string;
	resourcetype?: { collection?: unknown } | string;
	getlastmodified?: string;
	getcontentlength?: string;
	getcontenttype?: string;
	getetag?: string;
};

type WebDAVPropstat = {
	prop?: WebDAVProp;
	status?: string;
};

export type WebDAVResponseItem = {
	href: string;
	propstat?: WebDAVPropstat | Array<WebDAVPropstat>;
	status?: string;
};

export function normalizePath(path: string) {
	return normalizeRemotePath(extractPathname(path));
}

export function isSuccessStatus(status?: string): boolean {
	if (!status) return true;
	const match = /\s(?<code>\d{3})(?:\s|$)/.exec(status);
	if (!match) return false;
	const code = Number.parseInt(match.groups?.code ?? '', 10);
	return code >= 200 && code < 300;
}

export function getValidProps(item: WebDAVResponseItem): WebDAVProp | undefined {
	if (!item.propstat) return undefined;

	const propstats = Array.isArray(item.propstat) ? item.propstat : [item.propstat];

	for (const propstat of propstats) {
		if (!isSuccessStatus(propstat.status)) continue;
		if (propstat.prop) return propstat.prop;
	}

	return undefined;
}

function isCollectionResource(resourcetype: WebDAVProp['resourcetype']): boolean {
	if (!resourcetype) return false;
	if (typeof resourcetype === 'string') return resourcetype.toLowerCase() === 'collection';
	return !isNil(resourcetype.collection);
}

function extractNextLink(linkHeader: string): string | undefined {
	const matches = /<(?<href>[^>]+)>;\s*rel="next"/.exec(linkHeader);
	return matches?.groups?.href;
}

function extractPathname(href: string): string {
	return decodeURIComponent(
		href.startsWith('http://') || href.startsWith('https://') ? new URL(href).pathname : href,
	);
}

export function buildStripPrefixes(serverUrl: string): Array<string> {
	const endpointPath = extractPathname(serverUrl);
	return [endpointPath];
}

export function buildDirectoryUrl(serverUrl: string, _path: string): string {
	const normalized = normalizeRemotePath(_path);
	const path = normalized === '/' ? '/' : `${normalized}/`;
	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	return `${serverUrl}${encodedPath}`;
}

function buildItemUrl(serverUrl: string, _path: string): string {
	const normalizedPath = normalizeRemotePath(_path);
	const path =
		normalizedPath !== '/' && _path.endsWith('/') ? `${normalizedPath}/` : normalizedPath;
	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	return `${serverUrl}${encodedPath}`;
}

/** Marker embedded in the temp filename used for atomic uploads. Remote listing
 * skips anything containing it so a crashed upload's leftover is never synced. */
export const REMOTE_TEMP_MARKER = '.webdav-sync-upload-';

/** Advisory cross-device sync lock file kept at the remote sync root. */
export const REMOTE_LOCK_FILENAME = '.webdav-sync.lock';

/** Internal control files that must never be treated as syncable vault content. */
export function isRemoteInternalPath(path: string): boolean {
	return path.includes(REMOTE_TEMP_MARKER) || path.endsWith(REMOTE_LOCK_FILENAME);
}

export function convertToFileStat(
	stripPrefixes: Array<string>,
	item: WebDAVResponseItem,
): StatModel | undefined {
	const props = getValidProps(item);
	if (!props) return undefined;

	const isDir = isCollectionResource(props.resourcetype);

	let path = normalizePath(item.href);
	for (const prefix of stripPrefixes)
		if (prefix !== '/' && path.startsWith(prefix)) {
			path = path.slice(prefix.length);
			break;
		}

	// Never surface internal control files (atomic-upload temp leftovers, the
	// sync lock) as real remote entries, or they would be pulled down as files.
	if (isRemoteInternalPath(path)) return undefined;

	const filename = isDir ? `${path}/` : path;
	const lastModResp = props.getlastmodified;

	// https://github.com/hesprs/obsidian-webdav-sync/issues/119#issuecomment-4467822635
	const lastMod =
		typeof lastModResp === 'string'
			? lastModResp
			: typeof lastModResp === 'object'
				? (lastModResp as { '#text': string })['#text']
				: '';

	return isDir
		? { isDir, path: filename }
		: {
				isDir,
				etag: normalizeETag(props.getetag),
				mtime: new Date(lastMod).valueOf(),
				path: filename,
				size: props.getcontentlength ? parseInt(props.getcontentlength) : 0,
			};
}

/** Strip the weak-validator prefix and surrounding quotes so ETags compare equal
 * regardless of how a given server formats them. */
function normalizeETag(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.replace(/^W\//, '').replace(/"/g, '').trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <displayname/>
    <resourcetype/>
    <getlastmodified/>
    <getcontentlength/>
    <getcontenttype/>
    <getetag/>
  </prop>
</propfind>`;

async function propfind(
	endpoint: string,
	token: string,
	url: string,
	depth: '0' | '1' | 'infinity',
) {
	let retries = 0;
	while (true)
		try {
			const response = await requestUrl({
				body: PROPFIND_BODY,
				headers: {
					Authorization: `Basic ${token}`,
					'Content-Type': 'application/xml',
					Depth: depth,
				},
				method: 'PROPFIND',
				url,
			});

			const result: DAVResult = parseXML(response.text);
			const stripPrefixes = buildStripPrefixes(endpoint).sort((a, b) => b.length - a.length);
			const items = Array.isArray(result.multistatus.response)
				? result.multistatus.response
				: [result.multistatus.response];

			return {
				items,
				response,
				stripPrefixes,
			};
		} catch (error) {
			if (isRetryableError(error)) {
				retries++;
				if (retries > 3) throw error;
				logger.error('WebDAV connection error, retrying...', error);
				await sleep(5000);
				continue;
			}
			throw error;
		}
}

export async function getStat(endpoint: string, token: string, path: string): Promise<StatModel> {
	const { items, stripPrefixes } = await propfind(
		endpoint,
		token,
		buildItemUrl(endpoint, path),
		'0',
	);
	const normalizedTargetPath = normalizeRemotePath(path);

	for (const item of items) {
		const stat = convertToFileStat(stripPrefixes, item);
		if (!stat) continue;
		if (normalizeRemotePath(stat.path) === normalizedTargetPath) return stat;
	}

	throw new Error(`WebDAV stat not found for ${path}`);
}

export async function getDirectoryContents(
	endpoint: string,
	token: string,
	path: string,
	infinity = false,
): Promise<Array<StatModel>> {
	const contents: Array<StatModel> = [];
	let currentUrl = buildDirectoryUrl(endpoint, path);
	let retries = 0;

	while (true)
		try {
			const { items, response, stripPrefixes } = await propfind(
				endpoint,
				token,
				currentUrl,
				infinity ? 'infinity' : '1',
			);

			const parsedItems = items
				.slice(1)
				.map((item) => convertToFileStat(stripPrefixes, item))
				.filter((item): item is StatModel => item !== undefined);

			contents.push(...parsedItems);

			const linkHeader = response.headers.link || response.headers.Link;
			if (!linkHeader) break;

			const nextLink = extractNextLink(linkHeader);
			if (!nextLink) break;
			const nextUrl = new URL(nextLink);

			const pathName = normalizePath(nextUrl.pathname);
			nextUrl.pathname = `${pathName}/`;
			currentUrl = nextUrl.toString();
		} catch (error) {
			if (isRetryableError(error)) {
				retries++;
				if (retries > 3) throw error;
				logger.error('WebDAV connection error, retrying...', error);
				await sleep(5000);
				continue;
			}
			throw error;
		}

	return contents;
}
