import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  inferToolNameFromArguments,
  parseToolGrammarLeaks,
  repairAssistantMessageGrammarLeaks,
  type GrammarRepairConfig,
  type LiveToolSchema,
  type MinimalAssistantMessage,
} from "../src/index.js";

// Shapes observed from DeepSeek V4 Flash through OpenRouter: a space after the
// closing bar, a `calls` outer tag, and (on some backends) the
// `tool_calls`/`invoke name=` openers consumed before the text reaches Pi.

const config: GrammarRepairConfig = {
  enabled: true,
  grammars: ["dsml"],
  mode: "recover",
  requireKnownTool: true,
  debug: false,
};

const tools: LiveToolSchema[] = [
  { name: "read", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }) },
  { name: "ls", parameters: Type.Object({ path: Type.Optional(Type.String()) }) },
  { name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
  { name: "bash", parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }) },
];
const knownTools = new Set(tools.map((tool) => tool.name));
const infer = (args: Record<string, unknown>) => inferToolNameFromArguments(args, tools);

const textMessage = (text: string): MinimalAssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 1,
});

describe("DSML spaced markers and `calls` closer", () => {
  it("parses a complete call whose markers have a space after the bar", () => {
    const text = `<｜DSML｜ calls>
<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path" string="true">src/app.py</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

    expect(parseToolGrammarLeaks(text, ["dsml"])).toEqual([
      { name: "read", arguments: { path: "src/app.py" }, grammar: "dsml" },
    ]);
  });

  it("still parses canonical markers", () => {
    const text = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

    expect(parseToolGrammarLeaks(text, ["dsml"])).toEqual([
      { name: "bash", arguments: { command: "ls -la" }, grammar: "dsml" },
    ]);
  });
});

describe("headless DSML (openers consumed upstream)", () => {
  const headlessBash = `<parameter name="command">
 <｜DSML｜ parameter name="command" string="true">grep -n
 'foo\\|bar' src/cli.py</｜DSML｜ parameter>
 <｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>
 </｜DSML｜ invoke>
 </｜DSML｜ calls>`;

  it("recovers the call when exactly one active tool accepts the arguments (stray bare opener ignored)", () => {
    const result = repairAssistantMessageGrammarLeaks(textMessage(headlessBash), config, knownTools, infer);

    expect(result.message.stopReason).toBe("toolUse");
    expect(result.message.content).toEqual([
      { type: "text", text: "" },
      {
        type: "toolCall",
        id: expect.stringMatching(/^tool_repair_dsml_/),
        name: "bash",
        arguments: { command: "grep -n\n 'foo\\|bar' src/cli.py", timeout: 60 },
      },
    ]);
  });

  it("does not execute when the arguments fit more than one tool", () => {
    const text = `<parameter name="path">src/app.py</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;
    const result = repairAssistantMessageGrammarLeaks(textMessage(text), config, knownTools, infer);
    // `{path}` fits both `read` and `ls`, so nothing is executed.
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.content).toEqual([{ type: "text", text: "" }]);
  });

  it("strips and marks the message retryable when the tool cannot be inferred", () => {
    const text = `Now rewrite the file.

<parameter name="path">src/app.py</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;
    const result = repairAssistantMessageGrammarLeaks(textMessage(text), config, knownTools, infer);

    expect(result.changed).toBe(true);
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.content).toEqual([{ type: "text", text: "Now rewrite the file." }]);
    expect(result.message.stopReason).toBe("error");
    expect(result.message.errorMessage).toMatch(/stream was interrupted/);
  });

  it("strips without executing when no inference callback is provided", () => {
    const result = repairAssistantMessageGrammarLeaks(textMessage(headlessBash), config, knownTools);
    expect(result.recoveredCalls).toEqual([]);
    expect(result.message.stopReason).toBe("error");
  });

  it("leaves headless fragments inside code fences untouched", () => {
    const text = "Example:\n```\n<parameter name=\"command\">x</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n```";
    const result = repairAssistantMessageGrammarLeaks(textMessage(text), config, knownTools, infer);
    expect(result.changed).toBe(false);
  });
});

describe("inferToolNameFromArguments", () => {
  it("returns the single tool that declares and accepts every argument", () => {
    expect(infer({ command: "pwd", timeout: 5 })).toBe("bash");
    expect(infer({ path: "a", content: "b" })).toBe("write");
  });

  it("returns undefined when ambiguous, unknown, or empty", () => {
    expect(infer({ path: "a" })).toBeUndefined();
    expect(infer({ bogus: 1 })).toBeUndefined();
    expect(infer({})).toBeUndefined();
  });
});
