import type { Tool } from "../types";
import { readTool } from "./read";
import { writeTool } from "./write";
import { editTool } from "./edit";
import { grepTool } from "./grep";
import { findTool as findToolDef } from "./find";
import { lsTool } from "./ls";
import { bashTool } from "./bash";
import { powershellTool } from "./powershell";
import { memoryTool } from "./memory";
import { compactTool } from "./compact";

// 所有可用工具都注册在这里，顺序与 Pi 的内置工具一致（memory/compact 是本项目自加的）。
export const tools: Tool[] = [
	readTool,
	writeTool,
	editTool,
	grepTool,
	findToolDef,
	lsTool,
	bashTool,
	powershellTool,
	memoryTool,
	compactTool,
];

export function findTool(name: string): Tool | undefined {
	return tools.find((t) => t.name === name);
}

// 把我们的 Tool 转成 OpenAI 需要的格式，直接塞进请求的 tools 字段。
export function toOpenAITools() {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}
