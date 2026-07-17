import type { Vault } from 'obsidian';
import { useSettings } from '~/settings';
import postTraversal from '../post-traversal';
import { getLocalIndex, refreshLocalIndex } from './local-index';

type TraverseVaultOptions = {
	vault: Vault;
	/** Use the incrementally-maintained cache instead of a full walk. Only
	 * safe for the `fast` realtime-sync tier — see local-index.ts. Defaults to
	 * false so every existing caller (authoritative syncs, monitor mode)
	 * keeps doing a full, guaranteed-accurate walk unless it opts in. */
	useCache?: boolean;
};

export default async function traverse({ vault, useCache = false }: TraverseVaultOptions) {
	const { filterRules, skipLargeFiles } = await useSettings();
	const result = useCache ? await getLocalIndex(vault) : await refreshLocalIndex(vault);

	return postTraversal(
		result,
		filterRules,
		skipLargeFiles.enabled ? skipLargeFiles.value : undefined,
	);
}
