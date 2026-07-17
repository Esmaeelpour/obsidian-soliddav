import type { Vault } from 'obsidian';
import type { StatsMap } from '~/types';
import { normalizeVaultPath } from '~/platform/path';
import logger from '~/utils/logger';
import { toStatModel } from './utils';

/**
 * In-memory cache of the raw (pre-filter) local vault listing, kept warm by
 * vault events (see keepLocalIndexWarm below) instead of re-walking the whole
 * vault tree on every sync. Deliberately used ONLY for `fast` realtime syncs
 * (see traverse.ts) — every "authoritative" sync (manual, startup, scheduled,
 * app-resume) still does a full walk and refreshes this cache, so a missed or
 * misattributed event can only make one quick edit-triggered push briefly
 * stale, never a real sync.
 */
let cache: StatsMap | undefined;

async function fullWalk(vault: Vault): Promise<StatsMap> {
	const queue = [vault.getRoot().path];
	const result: StatsMap = new Map();

	while (queue.length > 0) {
		const currentLevelPaths = queue.splice(0);

		await Promise.all(
			currentLevelPaths.map(async (currentPath) => {
				try {
					const resultItems = await vault.adapter.list(currentPath);

					await Promise.all(
						[...resultItems.files, ...resultItems.folders].map(async (_path) => {
							const stat = await vault.adapter.stat(_path);
							if (!stat) throw new Error(`Stat of ${_path} not found!`);
							const path = normalizeVaultPath(_path);
							result.set(path, toStatModel(stat, path));
						}),
					);
					queue.push(...resultItems.folders);
				} catch (error) {
					logger.error(`Error processing ${currentPath}`, error);
					throw error;
				}
			}),
		);
	}
	return result;
}

/** Returns the cached raw local listing, doing a full walk only the first
 * time (or after `invalidateLocalIndex`). Callers that need a guaranteed-fresh
 * view should call `refreshLocalIndex` instead. */
export async function getLocalIndex(vault: Vault): Promise<StatsMap> {
	if (!cache) cache = await fullWalk(vault);
	return cache;
}

/** Forces a full re-walk and replaces the cache — used by authoritative
 * (non-fast) syncs, which must never rely on possibly-stale event tracking. */
export async function refreshLocalIndex(vault: Vault): Promise<StatsMap> {
	cache = await fullWalk(vault);
	return cache;
}

export function invalidateLocalIndex(): void {
	cache = undefined;
}

/** Incremental maintenance, called from the vault event listeners already
 * registered for realtime sync (sync-scheduler.service.ts). Best-effort: any
 * inconsistency here only affects the next `fast` sync, which is naturally
 * corrected by the next authoritative sync's full refresh. */
export async function noteLocalCreateOrModify(vault: Vault, path: string): Promise<void> {
	if (!cache) return; // Nothing to maintain until something has warmed it.
	try {
		const stat = await vault.adapter.stat(path);
		const normalized = normalizeVaultPath(path);
		if (stat) cache.set(normalized, toStatModel(stat, normalized));
		else cache.delete(normalized);
	} catch (error) {
		logger.warn(`local-index: failed to update entry for ${path}, invalidating cache`, error);
		invalidateLocalIndex();
	}
}

export function noteLocalDelete(path: string): void {
	if (!cache) return;
	const normalized = normalizeVaultPath(path);
	const prefix = `${normalized}/`;
	// A folder delete cascades to its descendants; if any cached entry lives
	// under this path, invalidate wholesale rather than leaving them orphaned
	// (we have no stat left to tell file from folder once it's gone).
	const hadDescendants = [...cache.keys()].some((key) => key.startsWith(prefix));
	if (hadDescendants) {
		invalidateLocalIndex();
		return;
	}
	cache.delete(normalized);
}

export async function noteLocalRename(vault: Vault, oldPath: string, newPath: string): Promise<void> {
	if (!cache) return;
	try {
		const stat = await vault.adapter.stat(newPath);
		// A folder rename moves every descendant's path too — patching just the
		// one entry would leave stale descendant paths in the cache. Simpler and
		// safe to invalidate wholesale; the next `fast` sync pays for one full
		// walk instead of risking a subtly wrong index.
		if (stat?.type === 'folder') {
			invalidateLocalIndex();
			return;
		}
		cache.delete(normalizeVaultPath(oldPath));
		if (stat) {
			const normalized = normalizeVaultPath(newPath);
			cache.set(normalized, toStatModel(stat, normalized));
		}
	} catch (error) {
		logger.warn(`local-index: failed to update rename ${oldPath} -> ${newPath}`, error);
		invalidateLocalIndex();
	}
}
