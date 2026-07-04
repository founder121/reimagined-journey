import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-3-5-sonnet-20241022";

const assertApiKey = () => {
  if (!ENV.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
};

const toText = (content: MessageContent | MessageContent[]): string => {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map(p => (typeof p === "string" ? p : p.type === "text" ? p.text : ""))
    .join("\n");
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const { messages, tools, toolChoice, tool_choice, maxTokens, max_tokens } = params;

  // Extract system prompt — Anthropic requires it as a top-level field
  const systemParts = messages.filter(m => m.role === "system");
  const system = systemParts.length > 0 ? toText(systemParts[systemParts.length - 1].content) : undefined;

  // Build Anthropic messages (no system role allowed in messages array)
  const anthropicMessages = messages
    .filter(m => m.role !== "system" && m.role !== "function")
    .map(m => {
      const role = m.role === "assistant" ? "assistant" as const : "user" as const;

      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [{
            type: "tool_result" as const,
            tool_use_id: m.tool_call_id || "unknown",
            content: toText(m.content),
          }],
        };
      }

      const parts = Array.isArray(m.content) ? m.content : [m.content];
      const contentBlocks = parts.map(p => {
        if (typeof p === "string") return { type: "text" as const, text: p };
        if (p.type === "text") return { type: "text" as const, text: p.text };
        // image_url and file_url simplified to text for now
        return { type: "text" as const, text: `[unsupported content: ${p.type}]` };
      });

      return { role, content: contentBlocks.length === 1 ? contentBlocks[0].text : contentBlocks };
    });

  const requestBody: Record<string, unknown> = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens ?? max_tokens ?? 8192,
    messages: anthropicMessages,
  };

  if (system) requestBody.system = system;

  // Convert OpenAI tools to Anthropic tools format
  if (tools && tools.length > 0) {
    requestBody.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));

    const tc = toolChoice || tool_choice;
    if (tc === "none") {
      requestBody.tool_choice = { type: "none" };
    } else if (tc && typeof tc === "object" && "name" in tc) {
      requestBody.tool_choice = { type: "tool", name: tc.name };
    } else if (tc && typeof tc === "object" && "type" in tc && tc.type === "function") {
      requestBody.tool_choice = { type: "tool", name: (tc as ToolChoiceExplicit).function.name };
    }
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ENV.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  const data = await response.json() as {
    id: string;
    model: string;
    stop_reason: string;
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const textBlock = data.content.find(c => c.type === "text");
  const toolBlocks = data.content.filter(c => c.type === "tool_use");

  const assistantMessage: InvokeResult["choices"][0]["message"] = {
    role: "assistant",
    content: textBlock?.text ?? "",
  };

  if (toolBlocks.length > 0) {
    assistantMessage.tool_calls = toolBlocks.map(t => ({
      id: t.id ?? `call_${Math.random().toString(36).slice(2)}`,
      type: "function" as const,
      function: {
        name: t.name ?? "",
        arguments: JSON.stringify(t.input ?? {}),
      },
    }));
  }

  return {
    id: data.id,
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [{
      index: 0,
      message: assistantMessage,
      finish_reason: data.stop_reason ?? "stop",
    }],
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
  };
}
