// Agent 运行时发出的「结构化事件」。
// 核心（agent.ts）只负责 emit，谁来消费（终端、JSON、存库、测试）由外部决定。
// 这样核心和界面就解耦了——这正是 Pi 的做法。

export type AgentEndReason = "done" | "repeat" | "abort" | "error";

export type AgentEvent =
	| { type: "turn_start"; turn: number; messageCount: number }
	| { type: "thinking"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "assistant"; text: string }
	| { type: "assistant_delta"; text: string }
	| { type: "tool_call"; id: string; name: string; args: string }
	| {
			type: "tool_result";
			id: string;
			name: string;
			output: string;
			isError: boolean;
			durationMs: number;
	  }
	| {
			type: "usage";
			turn: number;
			promptTokens: number;
			completionTokens: number;
			cachedTokens: number;
			totalTokens: number;
			sessionTokens: number;
			sessionCachedTokens: number;
			costUsd: number | null;
			sessionCostUsd: number | null;
	  }
	| { type: "compaction_start"; tokens: number }
	| {
			type: "compaction";
			tokensBefore: number;
			tokensAfter: number;
			summaryChars: number;
	  }
	| {
			type: "retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			error: string;
	  }
	| { type: "retry_end"; success: boolean; attempt: number }
	| { type: "agent_end"; reason: AgentEndReason; turns: number }
	| { type: "notice"; text: string }
	| { type: "error"; message: string };

export type Emit = (event: AgentEvent) => void;

export const noopEmit: Emit = () => {};
