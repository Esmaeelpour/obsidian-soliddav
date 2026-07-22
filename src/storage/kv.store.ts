import { BaseStore, KV_STORE_NAME } from './store.interface';

export class IndexedDbKvStore extends BaseStore {
	constructor() {
		super(KV_STORE_NAME);
	}

	async get(key: string): Promise<string | undefined> {
		return await this.run(
			'read kv entry',
			async () => (await this.store.getItem<string>(this.getKey('global', key))) ?? undefined,
		);
	}

	async set(key: string, value: string): Promise<void> {
		await this.run('write kv entry', async () => {
			await this.store.setItem(this.getKey('global', key), value);
		});
	}

	async remove(key: string): Promise<void> {
		await this.run('delete kv entry', async () => {
			await this.store.removeItem(this.getKey('global', key));
		});
	}
}

const kvStore = new IndexedDbKvStore();
export default kvStore;
