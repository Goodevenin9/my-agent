// 自动重试 + 指数退避（移植自 Pi 的 pi-ai/utils/retry）。
//
// 只对「临时性」错误重试：限流、5xx、网络、超时。
// 对「确定性」错误（配额/计费/401/400）立即失败——重试没用还烧钱。

export interface RetryPolicy {
	enabled: boolean;
	/** 最多重试几次（0 = 不重试）。首次调用不算重试。 */
	maxRetries: number;
	/** 基础延迟（毫秒）。第 attempt 次重试的延迟 = base * 2^(attempt-1)。 */
	baseDelayMs: number;
	/** 单次延迟上限，默认 60s。 */
	maxDelayMs?: number;
}

const DEFAULT_MAX_DELAY_MS = 60_000;

// 确定性错误：重试无用（配额、计费、限免额度）
const NON_RETRYABLE =
	/insufficient_quota|out of budget|quota exceeded|billing|FreeUsageLimit|GoUsageLimit|Monthly usage limit|available balance/i;

// 临时性错误：值得重试
const RETRYABLE =
	/rate.?limit|too many requests|429|500|502|503|504|520|524|overloaded|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(error|refused|lost|reset)|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|timeout|timed? out|terminated/i;

/** 取消（abort）不是错误，单独一类。 */
export class AbortError extends Error {
	constructor() {
		super("已取消");
		this.name = "AbortError";
	}
}

/** 判断一个错误是否值得重试。优先用 HTTP status，其次用错误文本。 */
export function isRetryableError(err: unknown): boolean {
	if (err instanceof AbortError) return false;
	// OpenAI SDK 的 APIError 带 status —— 比正则可靠
	const status = (err as { status?: unknown } | null)?.status;
	if (typeof status === "number") {
		if (status === 429) return true;
		if (status >= 500) return true;
		return false; // 其它 4xx（400/401/403…）不重试
	}
	const msg = err instanceof Error ? err.message : String(err);
	if (NON_RETRYABLE.test(msg)) return false;
	return RETRYABLE.test(msg);
}

/** 指数退避：base * 2^(attempt-1)，封顶 maxDelayMs。 */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safe = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safe, policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
}

/** 可以被 abort 打断的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new AbortError());
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new AbortError());
			},
			{ once: true },
		);
	});
}

export interface RetryHooks {
	/** 每次安排重试前调用（attempt 从 1 开始）。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		error: string,
	) => void;
	/** 重试循环结束时调用一次（success=true 表示后来成功了）。 */
	onRetryFinished?: (success: boolean, attempt: number) => void;
}

/** 跑一个异步操作，临时性失败就按退避策略重试。 */
export async function withRetry<T>(
	produce: () => Promise<T>,
	policy: RetryPolicy,
	signal: AbortSignal | undefined,
	hooks: RetryHooks = {},
): Promise<T> {
	const maxAttempts = policy.enabled ? policy.maxRetries : 0;
	let attempt = 0;

	for (;;) {
		try {
			const result = await produce();
			if (attempt > 0) hooks.onRetryFinished?.(true, attempt);
			return result;
		} catch (err) {
			if (signal?.aborted) {
				if (attempt > 0) hooks.onRetryFinished?.(false, attempt);
				throw new AbortError();
			}
			if (attempt >= maxAttempts || !isRetryableError(err)) {
				if (attempt > 0) hooks.onRetryFinished?.(false, attempt);
				throw err;
			}
			attempt++;
			const delayMs = retryDelayMs(policy, attempt);
			hooks.onRetryScheduled?.(
				attempt,
				maxAttempts,
				delayMs,
				err instanceof Error ? err.message : String(err),
			);
			await sleep(delayMs, signal); // 被 abort 会抛 AbortError
		}
	}
}
