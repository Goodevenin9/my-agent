import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editTool } from "../src/tools/edit";
import { withFileMutationQueue } from "../src/tools/file-mutation-queue";
import { writeTool } from "../src/tools/write";

const tmp = () => mkdtemp(join(tmpdir(), "ma-tools-"));

test("write 原子写：写完不留 .tmp 残留", async () => {
	const dir = await tmp();
	const file = join(dir, "a.txt");
	await writeTool.execute({ path: file, content: "hello" });
	assert.equal(await readFile(file, "utf8"), "hello");
	assert.deepEqual(await readdir(dir), ["a.txt"]);
});

test("edit 精确替换 + 唯一性校验", async () => {
	const dir = await tmp();
	const file = join(dir, "a.txt");
	await writeTool.execute({ path: file, content: "A\nB\n" });
	assert.match(
		await editTool.execute({ path: file, edits: [{ oldText: "A", newText: "X" }] }),
		/已编辑/,
	);
	assert.equal(await readFile(file, "utf8"), "X\nB\n");
	assert.match(
		await editTool.execute({ path: file, edits: [{ oldText: "zzz", newText: "q" }] }),
		/没找到/,
	);
});

test("写队列：同一文件的操作串行执行", async () => {
	const dir = await tmp();
	const file = join(dir, "q.txt");
	const order: string[] = [];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	await Promise.all([
		withFileMutationQueue(file, async () => {
			await sleep(40);
			order.push("first");
		}),
		withFileMutationQueue(file, async () => {
			order.push("second");
		}),
	]);
	assert.deepEqual(order, ["first", "second"]);
});
