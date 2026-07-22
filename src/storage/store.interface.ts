import type { LocalSpaceInstance } from 'localspace';
import localspace from 'localspace';
import isSub from '~/utils/is-sub';
import logger from '~/utils/logger';

export function createStorageUnavailableError(cause: unknown): Error {
	if (cause instanceof Error)
		return new Error(`Sync state storage unavailable: ${cause.message}`);
	return new Error('Sync state storage unavailable');
}

// Namespaced per plugin so SolidDAV never shares its sync-state baseline with
// another WebDAV-sync plugin (e.g. the upstream WebDAV Sync). Sharing the DB
// entangles baselines across plugins and causes spurious deletions/conflicts.
export const STORAGE_NAME = 'obsidian-soliddav';
export const SYNC_STATE_STORE_NAME = 'sync-state';
export const BASE_TEXT_STORE_NAME = 'base-text';
export const FILE_CHUNK_STORE_NAME = 'file-chunk';
export const KV_STORE_NAME = 'kv-store';

export function parseKey(key: string) {
	const i = key.indexOf(':');
	const j = key.indexOf(':', i + 1);
	return { namespace: key.slice(i + 1, j), path: key.slice(j + 1) };
}

export abstract class BaseStore {
	protected readonly store: LocalSpaceInstance;
	private initPromise: Promise<void> | undefined;
	private readonly storeName: string;
	private readonly namespaceKeysMap = new Map<string, Set<string>>();

	constructor(storeName: string) {
		this.store = localspace.createInstance({
			coalesceWindowMs: 500,
			coalesceWrites: true,
			driver: [localspace.INDEXEDDB],
			name: STORAGE_NAME,
			storeName,
		});
		this.storeName = storeName;
	}

	async initialize() {
		if (this.initPromise) return await this.initPromise;
		this.initPromise = this.store.ready().catch((error: unknown) => {
			const storageError = createStorageUnavailableError(error);
			logger.error(`Failed to initialize storage: ${this.storeName}`, error);
			throw storageError;
		});
		return await this.initPromise;
	}

	async unload() {
		this.namespaceKeysMap.clear();
		await this.store.destroy();
	}

	protected async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
		try {
			await this.initialize();
			return await action();
		} catch (error) {
			logger.error(`Failed to ${operation}`, error);
			throw error;
		}
	}

	protected async getNamespaceKeys(namespace: string): Promise<Set<string>> {
		if (this.namespaceKeysMap.has(namespace)) {
			return this.namespaceKeysMap.get(namespace) as Set<string>;
		}

		const allKeys = await this.store.keys();
		for (const key of allKeys) {
			const { namespace: ns } = parseKey(key);
			if (!ns) continue;
			let set = this.namespaceKeysMap.get(ns);
			if (!set) {
				set = new Set<string>();
				this.namespaceKeysMap.set(ns, set);
			}
			set.add(key);
		}

		if (!this.namespaceKeysMap.has(namespace)) {
			this.namespaceKeysMap.set(namespace, new Set<string>());
		}
		return this.namespaceKeysMap.get(namespace) as Set<string>;
	}

	protected trackKey(namespace: string, key: string): void {
		let set = this.namespaceKeysMap.get(namespace);
		if (!set) {
			set = new Set<string>();
			this.namespaceKeysMap.set(namespace, set);
		}
		set.add(key);
	}

	async removeEntry(namespace: string, path: string): Promise<void> {
		await this.run('delete record entry', async () => {
			const key = this.getKey(namespace, path);
			this.namespaceKeysMap.get(namespace)?.delete(key);
			await this.store.removeItem(key);
		});
	}

	async removeSubDir(_namespace: string, _path: string): Promise<void> {
		await this.run('delete record sub directory', async () => {
			const keys = (await this.store.keys()).filter((key) => {
				const { namespace, path } = parseKey(key);
				return namespace === _namespace && isSub(_path, path, true);
			});
			const nsSet = this.namespaceKeysMap.get(_namespace);
			for (const key of keys) nsSet?.delete(key);
			await this.store.removeItems(keys);
		});
	}

	async removeNamespace(_namespace: string): Promise<void> {
		await this.run('clear record in a namespace', async () => {
			const keys = (await this.store.keys()).filter(
				(key) => parseKey(key).namespace === _namespace,
			);
			this.namespaceKeysMap.delete(_namespace);
			await this.store.removeItems(keys);
		});
	}

	async removeAll(): Promise<void> {
		await this.run('clear record', async () => {
			this.namespaceKeysMap.clear();
			await this.store.clear();
		});
	}

	protected getKey(namespace: string, path: string): string {
		const key = `${this.storeName}:${namespace}:${path}`;
		this.trackKey(namespace, key);
		return key;
	}
}

export type FileChunkKey = {
	start: number;
	end: number;
	key: string;
};
