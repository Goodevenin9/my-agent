import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { limitToolOutput } from "../src/output";

const big = (n: number) =>
	Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

test("输出没超限：原样返回，不落盘", () => {
	const out = limitToolOutput("read", "hello\nworld");
	assert.equal(out.content, "hello\nworld");
	assert.equal(out.truncation, undefined);
});

test("输出超限：截断 + 落盘，且完整内容可回读", async () => {
	const out = limitToolOutput("read", big(5000));
	assert.ok(out.truncation, "应标记为已截断");
	assert.match(out.content, /完整输出已存到/);
	const full = await readFile(out.truncation!.fullOutputPath, "utf8");
	assert.equal(full, big(5000), "临时文件里应是完整输出");
	assert.ok(out.content.split("\n").length <= 2002);
});

test("bash/powershell 保留尾部，其余保留头部", () => {
	const text = big(5000);
	const tail = limitToolOutput("bash", text).content;
	assert.match(tail, /line 4999/);
	assert.match(tail, /仅显示最后/);

	const head = limitToolOutput("read", text).content;
	assert.match(head, /line 0\b/);
	assert.match(head, /仅显示前/);
});
