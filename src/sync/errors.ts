export class SyncCancelledError extends Error {
	constructor(message = 'Sync cancelled') {
		super(message);
		this.name = 'SyncCancelledError';
	}
}

export class SyncRetryExhaustedError extends Error {
	constructor(
		message = 'WebDAV connection failed after retries',
		readonly cause?: Error,
	) {
		super(message);
		this.name = 'SyncRetryExhaustedError';
	}
}

/** The configured remote sync root returned 404 during traversal — the folder
 * doesn't exist on the server (wrong path, or wrong case: WebDAV is
 * case-sensitive). Surfaced instead of treating the remote as empty, which would
 * make monitor mode report a misleading "Pending" and a full sync push the whole
 * vault. */
export class RemoteBaseDirNotFoundError extends Error {
	constructor(readonly remoteDir: string) {
		super(`Remote sync folder not found: ${remoteDir}`);
		this.name = 'RemoteBaseDirNotFoundError';
	}
}

export function isSyncCancelledError(error: unknown): error is SyncCancelledError {
	return error instanceof SyncCancelledError;
}

export function isRemoteBaseDirNotFoundError(
	error: unknown,
): error is RemoteBaseDirNotFoundError {
	return error instanceof RemoteBaseDirNotFoundError;
}

export function toError(error: unknown, fallbackMessage: string): Error {
	if (error instanceof Error) return error;
	return new Error(typeof error === 'string' ? error : fallbackMessage);
}
