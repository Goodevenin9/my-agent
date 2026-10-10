import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 文件修改队列（移植自 Pi 的 file-mutation-queue）。
 *
 * 作用：把「同一个文件」的修改操作串行化——同一个文件排队，一个改完再改下一个；
 * **不同文件仍然并行**。这样循环层可以放心用 Promise.all 并行执行工具，
 * 而不会出现「两个 edit 同时读原文件、后写的覆盖前写的」这种竞态。
 *
 * 用法：会写文件的工具，把「读 → 改 → 写」整段包进来：
 *   await withFileMutationQueue(path, async () => { ...read/modify/write... });
 */

const queues = new Map<string, Promise<void>>();
// 串行化「登记」这一步，保证同一时刻只有一个 key 在建立队列
let registrationQueue: Promise<void> = Promise.resolve();

function isMissingPathError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		((err as { code?: string }).code === "ENOENT" ||
			(err as { code?: string }).code === "ENOTDIR")
	);
}

/** 用 realpath 作 key，保证软链接/相对路径指向同一文件时也共用一条队列。 */
async function getQueueKey(filePath: string): Promise<string> {
	const resolved = resolve(filePath);
	try {
		return await realpath(resolved);
	} catch (err) {
		if (isMissingPathError(err)) return resolved; // 文件还不存在（新建）时用绝对路径
		throw err;
	}
}

export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getQueueKey(filePath);
		const current = queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((r) => {
			release = r;
		});
		const chained = current.then(() => next);
		queues.set(key, chained);
		return { key, current, chained, release };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, current, chained, release } = await registration;
	await current; // 等前面同一文件的操作用完
	try {
		return await fn();
	} finally {
		release(); // 放行下一个
		if (queues.get(key) === chained) queues.delete(key);
	}
}
