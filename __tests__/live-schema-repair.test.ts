import { Type } from "typebox";
import {
  repairAssistantToolCallInputs,
  repairInputAgainstLiveSchema,
  type MinimalAssistantMessage,
} from "../src/index.js";

const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

const messageWithCall = (name: string, args: unknown): MinimalAssistantMessage => ({
  role: "assistant",
  content: [{
    type: "toolCall",
    id: "call_1",
    name,
    arguments: args as Record<string, unknown>,
  }],
  stopReason: "toolUse",
});

const repairedArguments = (message: MinimalAssistantMessage): unknown =>
  (message.content[0] as Record<string, unknown>).arguments;

describe("live-schema input repair", () => {
  it("passes valid input through without cloning", () => {
    const input = { path: "/x", limit: 5 };
    const outcome = repairInputAgainstLiveSchema("read", input, readSchema);
    expect(outcome.status).toBe("unchanged");
    expect(outcome.input).toBe(input);
  });

  it("renames aliases and drops optional nulls before Pi validation", () => {
    const message = messageWithCall("read", { file_path: "/x", offset: null, limit: null });
    const result = repairAssistantToolCallInputs(message, [{ name: "read", parameters: readSchema }]);

    expect(result.changed).toBe(true);
    expect(repairedArguments(result.message)).toEqual({ path: "/x" });
    expect(result.repairs[0]?.status).toBe("recovered");
    expect(result.repairs[0]?.rulesFired).toEqual([
      "renameAliasedField",
      "dropNullOrUndefined",
    ]);
  });


  it("repairs option aliases, timeout units, and numeric strings", () => {
    const read = repairInputAgainstLiveSchema(
      "read",
      { path: "/x", start: "2", max: "20" },
      readSchema,
    );
    expect(read.status).toBe("recovered");
    expect(read.repaired).toEqual({ path: "/x", offset: 2, limit: 20 });
    expect(read.rulesFired).toEqual(["renameAliasedField", "coerceNumericString"]);

    const bashSchema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
    const bash = repairInputAgainstLiveSchema(
      "bash",
      { commandLine: "pwd", timeoutMs: "5000" },
      bashSchema,
    );
    expect(bash.status).toBe("recovered");
    expect(bash.repaired).toEqual({ command: "pwd", timeout: 5 });
    expect(bash.rulesFired).toEqual(["renameAliasedField", "convertTimeoutMilliseconds"]);
  });

  it("does not override a canonical required field with an alias", () => {
    const message = messageWithCall("read", { path: null, file_path: "/alias", offset: null });
    const result = repairAssistantToolCallInputs(message, [{ name: "read", parameters: readSchema }]);

    expect(result.changed).toBe(false);
    expect(result.message).toBe(message);
    expect(result.repairs[0]?.status).toBe("unrepairable");
    expect(result.repairs[0]?.repaired).toEqual({ path: null, file_path: "/alias" });
  });

  it("parses current edit arrays and repairs aliases inside each edit", () => {
    const editSchema = Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
    });
    const message = messageWithCall("edit", {
      path: "/x",
      edits: '[{"old_string":"a","new_content":"b"}]',
    });
    const result = repairAssistantToolCallInputs(message, [{ name: "edit", parameters: editSchema }]);

    expect(repairedArguments(result.message)).toEqual({
      path: "/x",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(result.repairs[0]?.rulesFired).toEqual([
      "parseJsonStringifiedArray",
      "renameAliasedField",
    ]);
  });

  it("moves legacy edit aliases into the current edits array", () => {
    const editSchema = Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
    });
    const outcome = repairInputAgainstLiveSchema(
      "edit",
      { file_path: "/x", from: "a", to: "b" },
      editSchema,
    );

    expect(outcome.status).toBe("recovered");
    expect(outcome.repaired).toEqual({
      path: "/x",
      edits: [{ oldText: "a", newText: "b" }],
    });
  });

  it("uses expected array fields to parse, wrap, or drop placeholders", () => {
    const schema = Type.Object({
      pattern: Type.String(),
      include: Type.Optional(Type.Array(Type.String())),
    });

    expect(repairInputAgainstLiveSchema("grep", { pattern: "x", include: '["a","b"]' }, schema).repaired)
      .toEqual({ pattern: "x", include: ["a", "b"] });
    expect(repairInputAgainstLiveSchema("grep", { pattern: "x", include: "a" }, schema).repaired)
      .toEqual({ pattern: "x", include: ["a"] });
    expect(repairInputAgainstLiveSchema("grep", { pattern: "x", include: {} }, schema).repaired)
      .toEqual({ pattern: "x" });
  });

  it("repairs the outer fabric_exec call from a live schema", () => {
    const schema = Type.Object({
      code: Type.String(),
      display: Type.Optional(Type.Union([
        Type.Object({ name: Type.Optional(Type.String()) }),
        Type.String(),
      ])),
    });
    const outcome = repairInputAgainstLiveSchema(
      "fabric_exec",
      { code: ["const x = 1;", "return x;"], display: null },
      schema,
    );

    expect(outcome.status).toBe("recovered");
    expect(outcome.repaired).toEqual({ code: "const x = 1;\nreturn x;" });
    expect(outcome.rulesFired).toEqual(["joinStringArray", "dropNullOrUndefined"]);
  });

  it("wraps a root fabric_exec code string and rejects mixed code arrays", () => {
    const schema = Type.Object({ code: Type.String() });
    expect(repairInputAgainstLiveSchema("fabric_exec", "return 1;", schema).repaired)
      .toEqual({ code: "return 1;" });

    const mixed = repairInputAgainstLiveSchema("fabric_exec", { code: ["return ", 1] }, schema);
    expect(mixed.status).toBe("unrepairable");
    expect(mixed.repaired).toBeUndefined();
  });

  it("ignores schemas for inactive or unknown calls", () => {
    const message = messageWithCall("read", { file_path: "/x" });
    const result = repairAssistantToolCallInputs(message, []);
    expect(result.changed).toBe(false);
    expect(result.repairs).toEqual([]);
  });
});
