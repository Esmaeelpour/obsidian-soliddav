import type { Vault } from 'obsidian';
import type { RecordStatsMap } from '~/types';
import { getContent } from '~/fs/vault';
import { arrayBufferToText } from '~/platform/binary';
import hashContent from '~/utils/content-hash';
import logger from '~/utils/logger';
import type { SyncRecord } from '~/storage';
import type { BaseTask } from '../tasks/task.interface';
import PushTask from '../tasks/push.task';
import RemoveRemoteTask from '../tasks/remove-remote.task';
import RenameRemoteTask from '../tasks/rename-remote.task';
import isMergeablePath from './is-mergeable-path';

type Keyed<T> = { task: T; key: string };

/**
 * Detects local renames/moves and replaces the resulting RemoveRemoteTask +
 * PushTask pair with a single RenameRemoteTask (a remote MOVE), avoiding a
 * full re-upload of a file whose bytes never changed.
 *
 * Matching requires an EXACT content match (stored base text for notes, a
 * stored content hash for binary files — see push.task.ts/pull.task.ts for
 * where that hash comes from) and exactly one candidate on each side; any
 * ambiguity (e.g. two files with identical content) is left alone and falls
 * back to the ordinary remove+push behaviour. Only local-only reads are
 * involved — nothing is downloaded from the server to make this decision.
 */
export default async function detectRenames(
	tasks: Array<BaseTask>,
	records: RecordStatsMap,
	vault: Vault,
): Promise<Array<BaseTask>> {
	const removeCandidates = tasks.filter(
		(task): task is RemoveRemoteTask => task instanceof RemoveRemoteTask,
	);
	// A push with no prior record is the signature of "first time this engine
	// has seen this path" — exactly what a moved-to destination looks like.
	const pushCandidates = tasks.filter(
		(task): task is PushTask => task instanceof PushTask && !records.has(task.localPath),
	);
	if (removeCandidates.length === 0 || pushCandidates.length === 0) return tasks;

	const syncRecord: SyncRecord = removeCandidates[0].options.syncRecord;

	const removeKeyed: Array<Keyed<RemoveRemoteTask>> = [];
	const removeSizes = new Set<number>();
	for (const task of removeCandidates) {
		const record = records.get(task.localPath);
		if (!record || record.local.isDir || record.remote.isDir) continue;
		const key = isMergeablePath(task.localPath)
			? await syncRecord.getBaseText(task.localPath)
			: record.local.hash;
		if (key !== undefined) {
			removeKeyed.push({ key: `${isMergeablePath(task.localPath)}:${key}`, task });
			removeSizes.add(record.remote.size);
		}
	}
	if (removeKeyed.length === 0) return tasks;

	const pushKeyed: Array<Keyed<PushTask>> = [];
	for (const task of pushCandidates) {
		if (!task.local || task.local.isDir) continue;
		if (!removeSizes.has(task.local.size)) continue;

		try {
			const content = await getContent(vault, task.localPath);
			const key = isMergeablePath(task.localPath)
				? await arrayBufferToText(content)
				: await hashContent(content);
			pushKeyed.push({ key: `${isMergeablePath(task.localPath)}:${key}`, task });
		} catch (error) {
			// File disappeared again before we could read it (fast churn) — leave
			// it to the ordinary push path, which already tolerates this.
			logger.warn(`detectRenames: could not read candidate ${task.localPath}`, error);
		}
	}
	if (pushKeyed.length === 0) return tasks;

	const removeByKey = groupByKey(removeKeyed);
	const pushByKey = groupByKey(pushKeyed);

	const toRemove = new Set<BaseTask>();
	const toAdd: Array<RenameRemoteTask> = [];

	for (const [key, removeGroup] of removeByKey) {
		// Ambiguous (e.g. duplicate files) — can't safely tell which is "the same
		// file", so leave every candidate sharing this key to the normal path.
		if (removeGroup.length !== 1) continue;
		const pushGroup = pushByKey.get(key);
		if (!pushGroup || pushGroup.length !== 1) continue;

		const removeTask = removeGroup[0];
		const pushTask = pushGroup[0];
		const record = records.get(removeTask.localPath);
		if (!record || record.remote.isDir || !pushTask.local) continue;

		toRemove.add(removeTask);
		toRemove.add(pushTask);
		toAdd.push(
			new RenameRemoteTask({
				local: pushTask.local,
				localPath: pushTask.localPath,
				oldLocalPath: removeTask.localPath,
				oldRemotePath: removeTask.remotePath,
				remote: record.remote,
				remotePath: pushTask.remotePath,
				syncRecord: removeTask.options.syncRecord,
				vault: removeTask.options.vault,
				webdav: removeTask.options.webdav,
			}),
		);
		logger.debug(`Detected rename: \`${removeTask.localPath}\` -> \`${pushTask.localPath}\``, {
			reason: 'identical content under a new path',
		});
	}

	if (toAdd.length === 0) return tasks;
	return [...tasks.filter((task) => !toRemove.has(task)), ...toAdd];
}

function groupByKey<T>(entries: Array<Keyed<T>>): Map<string, Array<T>> {
	const map = new Map<string, Array<T>>();
	for (const { key, task } of entries) {
		const list = map.get(key);
		if (list) list.push(task);
		else map.set(key, [task]);
	}
	return map;
}
