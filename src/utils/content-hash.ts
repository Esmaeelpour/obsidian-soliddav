import { xxhash64 } from 'hash-wasm';

/**
 * Fast non-cryptographic content hash used to confirm whether a file's bytes
 * actually changed, as a fallback when mtime/size alone can't be trusted (see
 * push.task.ts). xxHash64 is not collision-resistant against adversarial
 * input, which is irrelevant here — it's only ever compared against a value
 * this same device computed and stored earlier.
 */
export default async function hashContent(content: ArrayBuffer): Promise<string> {
	return xxhash64(new Uint8Array(content));
}
