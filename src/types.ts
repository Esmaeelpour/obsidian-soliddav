export type StatModel = FileStatModel | FolderStatModel;

export type FileStatModel = {
	path: string;
	isDir: false;
	mtime: number;
	size: number;
	/**
	 * Remote ETag from PROPFIND, when the server provides one. ETags are
	 * content-derived on most servers (Nextcloud/ownCloud/Apache), so they are a
	 * far stronger change signal than mtime, which is unreliable across devices.
	 */
	etag?: string;
	/**
	 * Content hash (local side only), stored whenever a task already has the
	 * file's bytes in hand. Lets a later push confirm whether a file flagged
	 * "changed" by mtime/size actually has different content — see
	 * push.task.ts. Not computed during traversal (would mean hashing the
	 * whole vault every sync), so it is a confirmation signal, not a
	 * replacement for the mtime/size check.
	 */
	hash?: string;
};

export type FolderStatModel = {
	path: string;
	isDir: true;
};

export enum SyncRunKind {
	normal = 'normal',
	fast = 'fast',
}

export type RecordStatModel = {
	local: StatModel;
	remote: StatModel;
};

export type StatsMap = Map<string, StatModel>;
export type RecordStatsMap = Map<string, RecordStatModel>;

export type MaybePromise<T> = Promise<T> | T;

export type ToggleNumericSettingsField = {
	enabled: boolean;
	value: number;
};
