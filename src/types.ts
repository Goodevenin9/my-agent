// 这里定义我们自己内部用到的最小类型。
// 看懂这两个接口，你就理解了 Agent 的「工具」和「消息」长什么样。

/** 对话里的一条消息。格式和 OpenAI Chat Completions 一致，方便直接发给模型。 */
export type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

/** 模型要求调用的一个工具。arguments 是 JSON 字符串（可能不合法，要 try/catch）。 */
export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

/**
 * 工具执行时的运行上下文。由 harness 注入，模型无法伪造。
 * 例：userTurnAskedToRemember 决定记忆能不能被当成「可信」——
 * 这个判断必须来自用户原话，而不能来自模型的自我声明（抗注入）。
 */
export interface ToolContext {
	/** 本轮用户的输入里是否明确要求「记住」 */
	userTurnAskedToRemember: boolean;
	/** 取消信号：长操作（bash/powershell 等）应传入并在被取消时尽快停止 */
	signal?: AbortSignal;
}

/** 工具的副作用等级：read 不影响外部；mutate 改文件；execute 执行命令。 */
export type ToolEffect = "read" | "mutate" | "execute";

/**
 * 一个工具 = 名字 + 给模型看的描述 + 参数 JSON Schema + 真正执行的函数。
 * execute 返回的字符串会作为工具结果喂回模型。
 * 注意：出错不要抛异常，要把错误信息当结果返回（模型会自己修正）。
 */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** 副作用等级。非 read 的工具在执行前可能被权限门拦一下。 */
	effect?: ToolEffect;
	execute: (args: Record<string, any>, ctx?: ToolContext) => Promise<string>;
}
