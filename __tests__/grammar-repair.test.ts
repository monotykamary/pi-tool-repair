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
});
