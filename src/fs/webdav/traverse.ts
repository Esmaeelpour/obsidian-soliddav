import type { RecordStatsMap, StatsMap } from '~/types';
import apiLimiter from '~/composable/api-limiter';
import { normalizePathToRelative, normalizeRemotePath } from '~/platform/path';
import { useSettings } from '~/settings';
import { RemoteBaseDirNotFoundError } from '~/sync/errors';
import { decryptRemotePathForTraversal } from '~/utils/encryption';
import { buildRules, needIncludeFromGlobRules } from '~/utils/glob-match';
import isRetryableError from '~/utils/is-retryable-error';
import logger from '~/utils/logger';
import sleep from '~/utils/sleep';
import type { TraversalProgress } from '../fs.interface';
import postTraversal from '../post-traversal';
import { getDirectoryContents } from './api';
import { trySyncCollection } from './sync-collection';

type TraverseWebDAVOptions = {
	onProgress?: (progress: TraversalProgress) => void;
	throwIfCancelled?: () => void;
	token: string;
	/** Previously-known remote records. When present (and encryption is off),
	 * used to attempt an RFC 6578 sync-collection delta instead of a full
	 * PROPFIND walk — see sync-collection.ts. Optional and purely additive:
	 * omitting it, or the server not supporting it, always falls back to the
	 * exact walk this function has always done. */
	records?: RecordStatsMap;
};

function isNotFoundError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const errWithRes = err as { res?: { status?: number }; message?: string };
	if (errWithRes.res?.status === 404) return true;
	return typeof errWithRes.message === 'string' && /^404\s*:/.test(errWithRes.message);
}

export default async function traverse({
	onProgress,
	token,
	throwIfCancelled,
	records,
}: TraverseWebDAVOptions) {
	const { filterRules, skipLargeFiles, serverUrl, remoteDir, exhaustiveRemoteTraversal } =
		await useSettings();
	const encrypted = (await useSettings()).encryption.enabled;
	const result: StatsMap = new Map();
	const baseDirNormalized = normalizeRemotePath(remoteDir);

	// Encrypted vaults store obfuscated paths server-side; reconstructing an
	// accurate base from records for the delta merge below has more edge cases
	// than this feature is worth risking there, so it's skipped entirely —
	// encrypted vaults always get the full, unambiguous walk.
	if (records && !encrypted) {
		const delta = await trySyncCollection(serverUrl, token, remoteDir);
		if (delta.supported) {
			for (const [vaultPath, record] of records) result.set(vaultPath, record.remote);

			for (const change of delta.changes) {
				const vaultPath = normalizePathToRelative(remoteDir, change.path);
				if (!change.stat) {
					result.delete(vaultPath);
					// A removed folder is reported as one entry, not per-descendant
					// (RFC 6578 §3.8) — drop anything the base thought lived under it.
					const prefix = `${vaultPath}/`;
					for (const key of [...result.keys()]) if (key.startsWith(prefix)) result.delete(key);
					continue;
				}
				result.set(vaultPath, change.stat);
			}

			onProgress?.({
				currentDirectory: remoteDir,
				processedDirectories: result.size,
				totalDirectories: result.size,
			});
			return postTraversal(
				result,
				filterRules,
				skipLargeFiles.enabled ? skipLargeFiles.value : undefined,
			);
		}
	}

	const getContentFunc = (path: string) =>
		apiLimiter.wrap(getDirectoryContents)(serverUrl, token, path, exhaustiveRemoteTraversal);

	const getContent = async (path: string) => {
		let retryCount = 0;
		while (true) {
			throwIfCancelled?.();
			if (retryCount > 3) throw new Error('Failed to get WebDAV content after 3 retries');
			try {
				retryCount++;
				return await getContentFunc(path);
			} catch (error) {
				if (isRetryableError(error)) await sleep(5000);
				else throw error;
			}
		}
	};

	const getRootContent = async () => {
		try {
			return await getContent(remoteDir);
		} catch (error) {
			if (isNotFoundError(error)) throw new RemoteBaseDirNotFoundError(remoteDir);
			throw error;
		}
	};

	if (exhaustiveRemoteTraversal) {
		const resultItems = await Promise.all(
			(await getRootContent()).map(async (stat) => {
				if (encrypted) stat.path = await decryptRemotePathForTraversal(stat.path);
				return stat;
			}),
		);
		for (const item of resultItems) {
			const vaultPath = normalizePathToRelative(remoteDir, item.path);
			result.set(vaultPath, item);
		}
		onProgress?.({
			currentDirectory: remoteDir,
			processedDirectories: result.size,
			totalDirectories: result.size,
		});
	} else {
		// Don't descend into excluded folders (e.g. .obsidian) while walking — it
		// saves many PROPFIND round-trips (a big deal on mobile latency). Only safe
		// to prune when there are no inclusion rules that could match inside them.
		const exclusions = buildRules(filterRules.exclusionRules);
		const inclusions = buildRules(filterRules.inclusionRules);
		const pruneExcludedDirs = (filterRules.inclusionRules?.length ?? 0) === 0;

		let processedCount = 0;
		const queue = [remoteDir];
		const reportProgress = (current: string) => {
			throwIfCancelled?.();
			processedCount++;
			onProgress?.({
				currentDirectory: current,
				processedDirectories: processedCount,
				totalDirectories: processedCount + queue.length,
			});
		};

		while (queue.length > 0) {
			const currentLevelPaths = queue.splice(0);

			await Promise.all(
				currentLevelPaths.map(async (currentPath) => {
					try {
						const resultItems = await Promise.all(
							(await getContent(currentPath)).map(async (stat) => {
								const listingPath = stat.path;
								if (encrypted)
									stat.path = await decryptRemotePathForTraversal(listingPath);
								return { listingPath, statModel: stat };
							}),
						);

						for (const item of resultItems) {
							const vaultPath = normalizePathToRelative(
								remoteDir,
								item.statModel.path,
							);
							result.set(vaultPath, item.statModel);
							if (item.statModel.isDir) {
								if (
									pruneExcludedDirs &&
									vaultPath.length > 0 &&
									!needIncludeFromGlobRules(vaultPath, inclusions, exclusions)
								)
									continue;
								queue.push(item.listingPath);
							}
						}
						reportProgress(currentPath);
					} catch (error) {
						logger.error(`Error processing ${currentPath}`, error);
						if (isNotFoundError(error)) {
							/* A 404 on the configured sync root means the remote folder
							 * doesn't exist (wrong path/case). Surface it — swallowing it
							 * would leave the remote listing empty, so monitor mode would
							 * report a misleading "Pending" and a full sync would try to
							 * push the whole vault. A 404 on a descendant is tolerated: it
							 * was likely deleted mid-walk. */
							if (normalizeRemotePath(currentPath) === baseDirNormalized)
								throw new RemoteBaseDirNotFoundError(remoteDir);
							reportProgress(currentPath);
							return;
						}
						throw error;
					}
				}),
			);
		}
	}

	return postTraversal(
		result,
		filterRules,
		skipLargeFiles.enabled ? skipLargeFiles.value : undefined,
	);
}
