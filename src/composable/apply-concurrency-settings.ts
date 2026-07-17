import { Platform } from 'obsidian';
import type { PluginSettings } from '~/settings';
import apiLimiter from './api-limiter';

/** Hard ceiling on concurrent WebDAV requests on mobile, regardless of the
 * configured desktop-oriented value. Real mobile networks (cellular, or Wi-Fi
 * behind a flaky router) don't tolerate 100 simultaneous sockets the way a
 * desktop Ethernet/Wi-Fi connection does — that many at once causes socket
 * contention, timeouts, and the retries/failures this is meant to prevent. */
const MOBILE_MAX_CONCURRENCY = 8;
/** Minimum gap between WebDAV requests on mobile, even if the desktop setting
 * has no interval configured — smooths bursts from the traversal/task queue. */
const MOBILE_MIN_INTERVAL_MS = 20;

/**
 * Apply the user's concurrency/rate-limit settings to the shared apiLimiter,
 * capping them on mobile. Call this at plugin load (the limiter previously
 * only picked up settings when the user happened to edit the control in the
 * Settings tab — meaning concurrency was effectively unbounded for anyone who
 * never touched that field) and again whenever the relevant settings change.
 */
export default function applyConcurrencySettings(settings: PluginSettings): void {
	const configuredMax = settings.maxWebDAVConcurrency.enabled
		? settings.maxWebDAVConcurrency.value
		: Infinity;
	const configuredInterval = settings.minWebDAVRequestInterval.enabled
		? settings.minWebDAVRequestInterval.value
		: 0;

	apiLimiter.maxConcurrency = Platform.isMobile
		? Math.min(configuredMax, MOBILE_MAX_CONCURRENCY)
		: configuredMax;
	apiLimiter.minInterval = Platform.isMobile
		? Math.max(configuredInterval, MOBILE_MIN_INTERVAL_MS)
		: configuredInterval;
}
