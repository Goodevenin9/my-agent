import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AbortError,
	isRetryableError,
	retryDelayMs,
	withRetry,
} from "../src/retry";

test("错误分类：429/5xx/网络可重试，400/配额不可重试", () => {
	assert.equal(isRetryableError(Object.assign(new Error("x"), { status: 429 })), true);
	assert.equal(isRetryableError(Object.assign(new Error("x"), { status: 503 })), true);
	assert.equal(isRetryableError(Object.assign(new Error("x"), { status: 400 })), false);
	assert.equal(isRetryableError(Object.assign(new Error("x"), { status: 401 })), false);
	assert.equal(isRetryableError(new Error("fetch failed")), true);
	assert.equal(isRetryableError(new Error("Request timed out")), true);
	assert.equal(isRetryableError(new Error("insufficient_quota")), false);
});

test("指数退避：base * 2^(n-1)", () => {
	const policy = { enabled: true, maxRetries: 5, baseDelayMs: 2000 };
	assert.deepEqual(
		[1, 2, 3, 4].map((a) => retryDelayMs(policy, a)),
		[2000, 4000, 8000, 16000],
	);
});

test("临时性错误重试后成功", async () => {
	let calls = 0;
	const result = await withRetry(
		async () => {
			calls++;
			if (calls < 3) throw Object.assign(new Error("x"), { status: 503 });
			return "ok";
		},
		{ enabled: true, maxRetries: 3, baseDelayMs: 1 },
		undefined,
	);
	assert.equal(result, "ok");
	assert.equal(calls, 3);
});

test("确定性错误立即失败（不重试）", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(
			async () => {
				calls++;
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
			{ enabled: true, maxRetries: 3, baseDelayMs: 1 },
			undefined,
		),
	);
	assert.equal(calls, 1);
});

test("退避等待中可被取消（不必等满）", async () => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 10);
	const t0 = Date.now();
	await assert.rejects(
		withRetry(
			async () => {
				throw Object.assign(new Error("x"), { status: 503 });
			},
			{ enabled: true, maxRetries: 9, baseDelayMs: 3000 },
			ac.signal,
		),
		(e: unknown) => e instanceof AbortError,
	);
	assert.ok(Date.now() - t0 < 1000, "应立刻返回，而不是等 3s");
});
