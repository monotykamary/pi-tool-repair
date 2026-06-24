import { describe, expect, it } from "vitest";
import {
  parseToolGrammarLeaks,
  repairAssistantMessageGrammarLeaks,
  type GrammarRepairConfig,
  type MinimalAssistantMessage,
} from "../src/index.js";

const enabledConfig: GrammarRepairConfig = {
  enabled: true,
  grammars: [
    "dsml",
    "invoke",
    "qwen",
    "kimi",
    "mistral",
    "llama",
    "glm",
    "granite",
    "minimax-text",
    "olmo",
  ],
  mode: "recover",
  requireKnownTool: true,
  debug: false,

};

describe("grammar leak parsing", () => {
  it("parses DeepSeek DSML double-bar, single-bar, and no-lead-bar variants", () => {
    const text = `
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="code_exec">
<｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
<｜DSML｜tool_calls>
<｜DSML｜invoke name="fetch">
<｜DSML｜parameter name="url" string="false">["x"]</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
<DSML｜tool_calls>
<DSML｜invoke name="bash">
</DSML｜invoke>`;

    const calls = parseToolGrammarLeaks(text, ["dsml"]);
    expect(calls).toEqual([
      { grammar: "dsml", name: "code_exec", arguments: { language: "python" } },
      { grammar: "dsml", name: "fetch", arguments: { url: ["x"] } },
      { grammar: "dsml", name: "bash", arguments: {} },
    ]);
  });

  it("preserves newlines inside DSML parameter values", () => {
    const text = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">echo one
&& echo two</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

    const [call] = parseToolGrammarLeaks(text, ["dsml"]);
    expect(call?.arguments).toEqual({ command: "echo one\n&& echo two" });
  });

  it("parses MiniMax invoke/parameter XML", () => {
    const text = `<minimax:tool_call>
<invoke name="search_web">
<parameter name="query_list">["weather"]</parameter>
</invoke>
</minimax:tool_call>`;

    const calls = parseToolGrammarLeaks(text, ["invoke"]);
    expect(calls).toEqual([
      { grammar: "invoke", name: "search_web", arguments: { query_list: ["weather"] } },
    ]);
  });

  it("parses Qwen function/parameter XML", () => {
    const text = `<tool_call>
<function=get_weather>
<parameter=location>Paris</parameter>
</function>
</tool_call>`;

    const calls = parseToolGrammarLeaks(text, ["qwen"]);
    expect(calls).toEqual([
      { grammar: "qwen", name: "get_weather", arguments: { location: "Paris" } },
    ]);
  });

  it("parses Kimi sentinel tool calls", () => {
    const text = `<|tool_calls_section_begin|><|tool_call_begin|>functions.web_search:0<|tool_call_argument_begin|>{"query":"pi"}<|tool_call_end|><|tool_calls_section_end|>`;

    const calls = parseToolGrammarLeaks(text, ["kimi"]);
    expect(calls).toEqual([
      { grammar: "kimi", name: "web_search", arguments: { query: "pi" } },
    ]);
  });

  it("keeps multiple calls from the same wrapper range", () => {
    const text = `<|tool_calls_section_begin|><|tool_call_begin|>functions.first:0<|tool_call_argument_begin|>{"a":1}<|tool_call_end|><|tool_call_begin|>functions.second:1<|tool_call_argument_begin|>{"b":2}<|tool_call_end|><|tool_calls_section_end|>`;

    const calls = parseToolGrammarLeaks(text, ["kimi"]);
    expect(calls).toEqual([
      { grammar: "kimi", name: "first", arguments: { a: 1 } },
      { grammar: "kimi", name: "second", arguments: { b: 2 } },
    ]);
  });

  it("parses Kimi console tool_call closed only by redacted_thinking", () => {
    const text = ` <tool_call> {"name": "bash", "arguments": {"command":"test"}}</${"redacted_thinking"}>`;
    expect(parseToolGrammarLeaks(text, ["kimi"])).toEqual([
      { grammar: "kimi", name: "bash", arguments: { command: "test" } },
    ]);
  });

  it("strips dangling Kimi tool_call open markers", () => {
    const result = repairAssistantMessageGrammarLeaks(
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll run this.\n<tool_call>\n" }],
        stopReason: "stop",
      },
      { ...enabledConfig, grammars: ["kimi"] },
      new Set(["bash"]),
    );
    expect(result.changed).toBe(true);
    expect(result.recoveredCalls).toEqual([]);
    expect((result.message.content[0] as { text: string }).text).toBe("I'll run this.");
  });

  it("strips truncated Kimi sentinel markers", () => {
    const result = repairAssistantMessageGrammarLeaks(
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "prefix\n<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0",
        }],
        stopReason: "stop",
      },
      { ...enabledConfig, grammars: ["kimi"] },
      new Set(["read"]),
    );
    expect(result.changed).toBe(true);
    expect(result.recoveredCalls).toEqual([]);
    expect((result.message.content[0] as { text: string }).text).toBe("prefix");
  });

  it("recovers Kimi K2.6 session-style duplicate-close tool_call leaks", () => {
    const text = `<tool_call>
{"name": "bash", "arguments": {"command":"cd /tmp && grep -l 'tool_call' *.ts"}}"</tool_call>
</tool_call>`;
    const result = repairAssistantMessageGrammarLeaks(
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
      enabledConfig,
      new Set(["bash"]),
    );
    expect(result.changed).toBe(true);
    expect(result.message.stopReason).toBe("toolUse");
    expect(result.message.content).toEqual([
      { type: "text", text: "" },
      {
        type: "toolCall",
        id: expect.stringMatching(/^tool_repair_/),
        name: "bash",
        arguments: { command: "cd /tmp && grep -l 'tool_call' *.ts" },
      },
    ]);
  });

  it("parses Mistral TOOL_CALLS JSON", () => {
    const text = `[TOOL_CALLS] [{"name":"calculator","arguments":{"operation":"2+2"},"id":"abc123XYZ"}]`;

    const calls = parseToolGrammarLeaks(text, ["mistral"]);
    expect(calls).toEqual([
      { grammar: "mistral", name: "calculator", arguments: { operation: "2+2" } },
    ]);
  });

  it("parses bare Mistral JSON tool text", () => {
    const text = `{"name":"calculator","arguments":{"operation":"2+2"}}`;

    const calls = parseToolGrammarLeaks(text, ["mistral"]);
    expect(calls).toEqual([
      { grammar: "mistral", name: "calculator", arguments: { operation: "2+2" } },
    ]);
  });

  it("parses Llama python_tag JSON", () => {
    const text = `<|python_tag|>{"name":"write_file","arguments":{"path":"/tmp/a","content":"x"}}`;

    const calls = parseToolGrammarLeaks(text, ["llama"]);
    expect(calls).toEqual([
      { grammar: "llama", name: "write_file", arguments: { path: "/tmp/a", content: "x" } },
    ]);
  });

  it("parses bare Llama JSON tool text", () => {
    const text = `{"name":"write_file","arguments":{"path":"/tmp/a","content":"x"}}`;

    const calls = parseToolGrammarLeaks(text, ["llama"]);
    expect(calls).toEqual([
      { grammar: "llama", name: "write_file", arguments: { path: "/tmp/a", content: "x" } },
    ]);
  });

  it("parses GLM arg_key/arg_value XML", () => {
    const text = `<tool_call>get_weather
<arg_key>city</arg_key>
<arg_value>Beijing</arg_value>
</tool_call>`;

    const calls = parseToolGrammarLeaks(text, ["glm"]);
    expect(calls).toEqual([
      { grammar: "glm", name: "get_weather", arguments: { city: "Beijing" } },
    ]);
  });

  it("parses GLM zero-argument XML", () => {
    const text = `<tool_call>get_current_date</tool_call>`;

    const calls = parseToolGrammarLeaks(text, ["glm"]);
    expect(calls).toEqual([
      { grammar: "glm", name: "get_current_date", arguments: {} },
    ]);
  });

  it("parses Granite JSON tool_call", () => {
    const text = `<tool_call>
{"name":"get_current_weather","arguments":{"city":"London"}}
</tool_call>`;

    const calls = parseToolGrammarLeaks(text, ["granite"]);
    expect(calls).toEqual([
      { grammar: "granite", name: "get_current_weather", arguments: { city: "London" } },
    ]);
  });

  it("parses Granite pythonic tool text", () => {
    const text = `get_weather(location="San Francisco", unit="celsius")`;

    const calls = parseToolGrammarLeaks(text, ["granite"]);
    expect(calls).toEqual([
      { grammar: "granite", name: "get_weather", arguments: { location: "San Francisco", unit: "celsius" } },
    ]);
  });

  it("parses MiniMax-Text-01 typescript function calls", () => {
    const text = `<function_call>\`\`\`typescript
functions.get_current_weather({"location":"Shanghai"})
\`\`\``;

    const calls = parseToolGrammarLeaks(text, ["minimax-text"]);
    expect(calls).toEqual([
      { grammar: "minimax-text", name: "get_current_weather", arguments: { location: "Shanghai" } },
    ]);
  });

  it("parses OLMo pythonic function calls", () => {
    const text = `<function_calls>
write_file(path="/tmp/a", content="hello", overwrite=True)
</function_calls>`;

    const calls = parseToolGrammarLeaks(text, ["olmo"]);
    expect(calls).toEqual([
      { grammar: "olmo", name: "write_file", arguments: { path: "/tmp/a", content: "hello", overwrite: true } },
    ]);
  });

  it("does not parse tool grammar inside markdown code fences", () => {
    const text = "```xml\n<tool_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>\n```";
    expect(parseToolGrammarLeaks(text, ["granite"])).toEqual([]);
  });
});

// Truncated / dangling DSML markers — stream died mid-token. These can never
// be recovered as tool calls (incomplete), but the raw marker should not
// persist as visible assistant text. Covered for issue #3712.
describe("DSML dangling marker stripping", () => {
  it("does not report a truncated DSML open marker as a recovered call", () => {
    expect(parseToolGrammarLeaks("I'll read the file.\n<｜DSML｜tool_calls", ["dsml"])).toEqual([]);
  });

  it("does not report orphan markers from a truncated body as recovered calls", () => {
    expect(parseToolGrammarLeaks("<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"read\">", ["dsml"])).toEqual([]);
  });
});

describe("assistant message grammar repair", () => {
  it("strips leaked text and appends a recovered toolCall", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `I'll use the tool.
<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`,
        },
      ],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["bash"]));

    expect(result.changed).toBe(true);
    expect(result.message.stopReason).toBe("toolUse");
    expect(result.message.content).toEqual([
      { type: "text", text: "I'll use the tool." },
      {
        type: "toolCall",
        id: expect.stringMatching(/^tool_repair_dsml_/),
        name: "bash",
        arguments: { command: "pwd" },
      },
    ]);
  });

  it("requires known tools by default", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: `<tool_call>{"name":"unknown","arguments":{}}</tool_call>` },
      ],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["bash"]));
    expect(result.changed).toBe(false);
  });

  it("does not recover a call with empty arguments", () => {
    // GLM-style empty tool calls (e.g. `<tool_call>write</tool_call>`) would
    // otherwise be promoted to a native `toolCall` block with `{}` arguments,
    // causing a validation error when pi tries to execute them. They should be
    // stripped from the text but not recovered.
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `<tool_call>write</tool_call>` }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["write"]));
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.stopReason).toBe("stop");
    expect((result.message.content[0] as { text: string }).text).not.toContain("tool_call");
  });

  it("strips a truncated DSML open marker (stream died mid-token, issue #3712)", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "I'll read the file.\n<｜DSML｜tool_calls" }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["read"]));
    expect(result.changed).toBe(true);
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.stopReason).toBe("stop");
    expect(result.message.content).toEqual([{ type: "text", text: "I'll read the file." }]);
  });

  it("strips orphan DSML markers from a truncated body without recovering a call", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{
        type: "text",
        text: "I'll inspect.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"read\">\n<｜DSML｜parameter name=\"path\" string=\"true\">/foo",
      }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["read"]));
    expect(result.changed).toBe(true);
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.stopReason).toBe("stop");
    const text = (result.message.content[0] as { text: string }).text;
    expect(text).not.toContain("DSML");
    expect(text).toContain("I'll inspect.");
    expect(text).toContain("/foo");
  });

  it("strips dangling DSML markers in strip mode too", () => {
    const stripConfig: GrammarRepairConfig = { ...enabledConfig, mode: "strip" };
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi\n<｜DSML｜tool_calls" }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, stripConfig, new Set());
    expect(result.changed).toBe(true);
    expect((result.message.content[0] as { text: string }).text).toBe("hi");
  });

  it("does not strip a truncated DSML marker inside a code fence", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "```\n<｜DSML｜tool_calls\n```" }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["read"]));
    expect(result.changed).toBe(false);
  });

  it("does not double-strip dangling markers already covered by a complete DSML block", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      content: [{
        type: "text",
        text: `prefix
<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`,
      }],
      stopReason: "stop",
      timestamp: 1,
    };

    const result = repairAssistantMessageGrammarLeaks(message, enabledConfig, new Set(["bash"]));
    expect(result.recoveredCalls).toHaveLength(1);
    expect(result.recoveredCalls[0]).toEqual({ grammar: "dsml", name: "bash", arguments: { command: "pwd" } });
    expect((result.message.content[0] as { text: string }).text).toBe("prefix");
  });
});


