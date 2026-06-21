import type { RecordStatsMap, StatsMap } from '~/types';
import isSub from '~/utils/is-sub';
import type { BaseTask } from '../tasks/task.interface';
import MergeTask from '../tasks/merge.task';
import PullTask from '../tasks/pull.task';
import PushTask from '../tasks/push.task';
import isSameTime from './is-same-time';

export default function isChanged({
	path,
	source,
	records,
	tasks,
	currentStats,
}: {
	path: string;
	source: 'local' | 'remote';
	records: RecordStatsMap;
	currentStats: StatsMap;
	tasks?: Array<BaseTask>;
}) {
	const thisRecord = records.get(path)?.[source];
	const target = currentStats.get(path);
	if (!thisRecord || !target) return true;
	// Unable to compare between directories and files
	if (target.isDir !== thisRecord.isDir) return true;
	// Compare files
	if (!target.isDir && !thisRecord.isDir) {
		// Prefer the strongest available validator. ETags are content-derived on
		// most WebDAV servers, so they detect remote changes reliably even when
		// mtimes are equal or skewed across devices.
		if (source === 'remote' && target.etag && thisRecord.etag)
			return target.etag !== thisRecord.etag;
		// Fall back to mtime + size. Size was previously ignored, which both missed
		// same-mtime edits and flagged spurious changes; comparing both is cheap
		// and materially more accurate.
		return !isSameTime(target.mtime, thisRecord.mtime) || target.size !== thisRecord.size;
	} else {
		// Compare folders
		if (tasks)
			// Reuse tracked file changes
			for (const task of tasks)
				if (
					(task instanceof MergeTask ||
						task instanceof PushTask ||
						task instanceof PullTask) &&
					isSub(path, task.localPath)
				)
					return true;
		for (const [subPath, stats] of currentStats) {
			// Check for subfolder changes
			if (!stats.isDir || !isSub(path, subPath)) continue;
			const recorded = records.get(subPath)?.[source];
			if (!recorded) return true;
		}
	}
	return false;
}
