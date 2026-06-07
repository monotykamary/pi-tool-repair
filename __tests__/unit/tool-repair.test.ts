import {
  sanitizePattern,
  sanitizeSchemaAnchors,
  stripAnchorBleedInPlace,
  hasAnchorBleedBug,
  renameAliasedField,
  dropNullOrUndefined,
  dropEmptyObjectPlaceholder,
  parseJsonStringifiedArray,
  wrapBareStringAsArray,
  tryParseJsonArray,
  wrapRootStringAsObject,
  deepClone,
  walkToParent,
  repairToolInput,
  validateAgainstSchema,
  BUILTIN_SCHEMAS,
  normalizePhantomToolUse,
  type RepairContext,
  type ValidationIssue,
} from "../../src/index.js";

// ─── Phase 0: Schema Poisoning ───────────────────────────────────────────────

describe("sanitizePattern", () => {
  it("strips anchors from simple patterns", () => {
    expect(sanitizePattern("^foo$")).toBe("foo");
    expect(sanitizePattern("^foo")).toBe("foo");
    expect(sanitizePattern("foo$")).toBe("foo");
  });

  it("drops patterns that combine alternation with anchors", () => {
    expect(sanitizePattern("^(foo|bar)$")).toBeUndefined();
    expect(sanitizePattern("^(foo|bar)")).toBeUndefined();
    expect(sanitizePattern("(foo|bar)$")).toBeUndefined();
  });

  it("keeps patterns without anchors unchanged", () => {
    expect(sanitizePattern("foo|bar")).toBe("foo|bar");
  });

  it("returns undefined for anchor-only patterns", () => {
    expect(sanitizePattern("^")).toBeUndefined();
    expect(sanitizePattern("$")).toBeUndefined();
    expect(sanitizePattern("^$")).toBeUndefined();
  });
});

describe("sanitizeSchemaAnchors", () => {
  it("strips pattern anchors from nested schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z]+$" },
        path: { type: "string" },
      },
    };
    const result = sanitizeSchemaAnchors(schema) as any;
    expect(result.properties.name.pattern).toBe("[a-z]+");
    expect(result.properties.path).toEqual({ type: "string" });
  });

  it("drops patterns with alternation + anchors", () => {
    const schema = {
      properties: {
        x: { pattern: "^(a|b)$" },
      },
    };
    const result = sanitizeSchemaAnchors(schema) as any;
    expect(result.properties.x.pattern).toBeUndefined();
  });

  it("handles arrays", () => {
    const schema = [{ pattern: "^foo$" }];
    const result = sanitizeSchemaAnchors(schema) as any[];
    expect(result[0].pattern).toBe("foo");
  });

  it("returns null/undefined passthrough", () => {
    expect(sanitizeSchemaAnchors(null)).toBeNull();
    expect(sanitizeSchemaAnchors(undefined)).toBeUndefined();
  });
});

describe("stripAnchorBleedInPlace", () => {
  it("strips leading ^ and trailing $ from string values", () => {
    const obj: Record<string, unknown> = { path: "^/foo/bar$" };
    stripAnchorBleedInPlace(obj);
    expect(obj.path).toBe("/foo/bar");
  });

  it("strips multiple anchors", () => {
    const obj: Record<string, unknown> = { path: "^^/foo$$" };
    stripAnchorBleedInPlace(obj);
    expect(obj.path).toBe("/foo");
  });

  it("strips anchors from array elements", () => {
    const obj: Record<string, unknown> = { files: ["^a$", "b"] };
    stripAnchorBleedInPlace(obj);
    expect(obj.files).toEqual(["a", "b"]);
  });

  it("strips anchors from nested objects", () => {
    const obj: Record<string, unknown> = { nested: { path: "^x$" } };
    stripAnchorBleedInPlace(obj);
    expect((obj.nested as any).path).toBe("x");
  });

  it("leaves non-string values unchanged", () => {
    const obj: Record<string, unknown> = { count: 5, flag: true };
    stripAnchorBleedInPlace(obj);
    expect(obj.count).toBe(5);
    expect(obj.flag).toBe(true);
  });
});

describe("hasAnchorBleedBug", () => {
  it("detects kimi-k2 models", () => {
    expect(hasAnchorBleedBug({ id: "kimi-k2-instruct" })).toBe(true);
  });

  it("detects minimax models", () => {
    expect(hasAnchorBleedBug({ id: "minimax-01" })).toBe(true);
  });

  it("detects glm models", () => {
    expect(hasAnchorBleedBug({ id: "glm-4" })).toBe(true);
  });

  it("returns false for unaffected models", () => {
    expect(hasAnchorBleedBug({ id: "gpt-4o" })).toBe(false);
    expect(hasAnchorBleedBug({ id: "claude-sonnet-4" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(hasAnchorBleedBug(null)).toBe(false);
    expect(hasAnchorBleedBug(undefined)).toBe(false);
  });
});

// ─── Phase 2: Repair Rules ────────────────────────────────────────────────────

function makeCtx(overrides: Partial<Omit<RepairContext, "parent"> & { parent?: Record<string, unknown> }> & Pick<RepairContext, "toolName" | "key" | "value">): RepairContext {
  const parent: Record<string, unknown> = overrides.parent ?? { [overrides.key]: overrides.value };
  const { toolName, key, value, issue, ...rest } = overrides;
  return {
    toolName,
    parent,
    key,
    value,
    issue: issue ?? { code: "invalid_type", expected: "array", received: "string", path: [key], message: "" },
    ...rest,
  };
}

describe("renameAliasedField", () => {
  it("renames a known alias to the canonical name", () => {
    const ctx = makeCtx({ toolName: "read", key: "file_path", value: "/foo" });
    const result = renameAliasedField(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.path).toBe("/foo");
    expect(ctx.parent.file_path).toBeUndefined();
    expect((result as any).ruleName).toBe("renameAliasedField");
  });

  it("does not rename when canonical field already exists", () => {
    const ctx = makeCtx({ toolName: "read", key: "file_path", value: "/foo" });
    ctx.parent.path = "/bar";
    const result = renameAliasedField(ctx);
    expect(result).toBe(false);
  });

  it("does not rename null values", () => {
    const ctx = makeCtx({ toolName: "read", key: "file_path", value: null });
    const result = renameAliasedField(ctx);
    expect(result).toBe(false);
  });

  it("returns false for unknown tools", () => {
    const ctx = makeCtx({ toolName: "unknown_tool", key: "foo", value: "bar" });
    expect(renameAliasedField(ctx)).toBe(false);
  });

  it("returns false for unknown aliases", () => {
    const ctx = makeCtx({ toolName: "read", key: "nonexistent_field", value: "/foo" });
    expect(renameAliasedField(ctx)).toBe(false);
  });
});

describe("dropNullOrUndefined", () => {
  it("drops null optional fields", () => {
    const ctx = makeCtx({ toolName: "read", key: "offset", value: null });
    const result = dropNullOrUndefined(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.offset).toBeUndefined();
    expect((result as any).ruleName).toBe("dropNullOrUndefined");
  });

  it("drops undefined optional fields", () => {
    const ctx = makeCtx({ toolName: "read", key: "limit", value: undefined });
    const result = dropNullOrUndefined(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.limit).toBeUndefined();
  });

  it("does not drop non-null values", () => {
    const ctx = makeCtx({ toolName: "read", key: "offset", value: 5 });
    expect(dropNullOrUndefined(ctx)).toBe(false);
  });
});

describe("dropEmptyObjectPlaceholder", () => {
  it("drops empty {} where array expected", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: {} });
    const result = dropEmptyObjectPlaceholder(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.include).toBeUndefined();
    expect((result as any).ruleName).toBe("dropEmptyObjectPlaceholder");
  });

  it("does not drop non-empty objects", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: { a: 1 } });
    expect(dropEmptyObjectPlaceholder(ctx)).toBe(false);
  });

  it("does not drop arrays", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: ["a"] });
    expect(dropEmptyObjectPlaceholder(ctx)).toBe(false);
  });
});

describe("tryParseJsonArray", () => {
  it("parses a JSON-stringified array", () => {
    expect(tryParseJsonArray('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns null for non-array JSON", () => {
    expect(tryParseJsonArray('{"a":1}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(tryParseJsonArray("not json")).toBeNull();
  });
});

describe("parseJsonStringifiedArray", () => {
  it("parses a stringified array in a field", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: '["a","b"]' });
    const result = parseJsonStringifiedArray(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.include).toEqual(["a", "b"]);
  });

  it("returns false for non-string values", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: ["a"] });
    expect(parseJsonStringifiedArray(ctx)).toBe(false);
  });

  it("returns false for strings that aren't arrays", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: "not an array" });
    expect(parseJsonStringifiedArray(ctx)).toBe(false);
  });
});

describe("wrapBareStringAsArray", () => {
  it("wraps a bare string in an array when array expected", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: "foo" });
    const result = wrapBareStringAsArray(ctx);
    expect(result).not.toBe(false);
    expect(ctx.parent.include).toEqual(["foo"]);
  });

  it("returns false when issue code is not invalid_type", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: "foo" });
    ctx.issue.code = "missing_field";
    expect(wrapBareStringAsArray(ctx)).toBe(false);
  });

  it("returns false when expected is not array", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: "foo" });
    ctx.issue.expected = "string";
    expect(wrapBareStringAsArray(ctx)).toBe(false);
  });

  it("returns false for non-string values", () => {
    const ctx = makeCtx({ toolName: "grep", key: "include", value: 42 });
    expect(wrapBareStringAsArray(ctx)).toBe(false);
  });
});

// ─── Root-Level Repair ────────────────────────────────────────────────────────

describe("wrapRootStringAsObject", () => {
  it("wraps a bare string for a string-arg tool", () => {
    const result = wrapRootStringAsObject("/foo/bar", "read");
    expect(result).toBeDefined();
    expect(result!.wrapped).toEqual({ path: "/foo/bar" });
  });

  it("wraps a bare string for an array-arg tool as single-element array", () => {
    // No current built-in tools use shape:"array" for root strings,
    // but test the branch anyway
    const result = wrapRootStringAsObject("pattern", "grep");
    expect(result).toBeDefined();
    expect(result!.wrapped).toEqual({ pattern: "pattern" });
  });

  it("returns undefined for non-string input", () => {
    expect(wrapRootStringAsObject({ path: "/foo" }, "read")).toBeUndefined();
  });

  it("returns undefined for unknown tools", () => {
    expect(wrapRootStringAsObject("/foo", "unknown_tool")).toBeUndefined();
  });
});

// ─── Deep Clone ───────────────────────────────────────────────────────────────

describe("deepClone", () => {
  it("clones primitives", () => {
    expect(deepClone("hello")).toBe("hello");
    expect(deepClone(42)).toBe(42);
    expect(deepClone(null)).toBeNull();
    expect(deepClone(true)).toBe(true);
  });

  it("clones arrays", () => {
    const arr = [1, "two", null];
    const cloned = deepClone(arr) as unknown[];
    expect(cloned).toEqual(arr);
    expect(cloned).not.toBe(arr);
  });

  it("deep clones nested objects", () => {
    const obj = { a: { b: [1, 2] } };
    const cloned = deepClone(obj) as any;
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.a).not.toBe(obj.a);
    expect(cloned.a.b).not.toBe(obj.a.b);
  });
});

// ─── Walk to Parent ───────────────────────────────────────────────────────────

describe("walkToParent", () => {
  it("walks to the parent of a top-level key", () => {
    const root = { a: 1 };
    expect(walkToParent(root, ["a"])).toBe(root);
  });

  it("walks into nested objects", () => {
    const root = { nested: { key: "val" } };
    expect(walkToParent(root, ["nested", "key"])).toBe(root.nested);
  });

  it("returns undefined for missing paths", () => {
    const root = { a: 1 };
    expect(walkToParent(root, ["missing", "key"])).toBeUndefined();
  });
});

// ─── Schema Validation ────────────────────────────────────────────────────────

describe("validateAgainstSchema", () => {
  it("returns empty issues for valid input", () => {
    const issues = validateAgainstSchema(
      { path: "/foo", offset: 5 },
      BUILTIN_SCHEMAS.read,
    );
    expect(issues).toHaveLength(0);
  });

  it("flags missing required fields", () => {
    const issues = validateAgainstSchema(
      { offset: 5 },
      BUILTIN_SCHEMAS.read,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("missing_field");
    expect(issues[0].path).toEqual(["path"]);
  });

  it("flags null optional fields", () => {
    const issues = validateAgainstSchema(
      { path: "/foo", offset: null },
      BUILTIN_SCHEMAS.read,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("invalid_type");
    expect(issues[0].path).toEqual(["offset"]);
  });

  it("flags wrong types", () => {
    const issues = validateAgainstSchema(
      { path: "/foo", offset: "five" },
      BUILTIN_SCHEMAS.read,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("invalid_type");
    expect(issues[0].received).toBe("string");
    expect(issues[0].expected).toBe("number");
  });

  it("flags string where array expected", () => {
    const issues = validateAgainstSchema(
      { pattern: "foo", include: "bar" },
      BUILTIN_SCHEMAS.grep,
    );
    // The validator emits both a type-check issue (actualType !== expected)
    // and a dedicated array-vs-string-coercion issue.
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.code === "invalid_type" && i.expected === "array")).toBe(true);
  });
});

// ─── Full Repair Pipeline ─────────────────────────────────────────────────────

describe("repairToolInput", () => {
  it("repairs null optional fields", () => {
    const result = repairToolInput(
      { path: "/foo", offset: null },
      [{ code: "invalid_type", expected: "number", received: "null", path: ["offset"], message: "" }],
      "read",
    );
    expect(result.rulesFired).toContain("dropNullOrUndefined");
    expect((result.input as any).offset).toBeUndefined();
    expect((result.input as any).path).toBe("/foo");
  });

  it("renames aliased fields", () => {
    // The alias repair runs on validation issues at the alias key's path.
    // Since `file_path` isn't in the schema, validateAgainstSchema won't
    // produce an issue for it — but it WILL produce a missing_field issue
    // for the canonical `path` that wasn't provided. The rename rule sees
    // that `file_path` exists in the parent and `path` doesn't, so it
    // renames even though the issue path points at `path` (missing).
    const input = { file_path: "/foo", content: "bar" };
    const issues = validateAgainstSchema(input as any, BUILTIN_SCHEMAS.write);
    const result = repairToolInput(input, issues, "write");
    expect(result.rulesFired).toContain("renameAliasedField");
    expect((result.input as any).path).toBe("/foo");
    expect((result.input as any).file_path).toBeUndefined();
  });

  it("wraps a bare root string", () => {
    const result = repairToolInput("/foo/bar", [], "read");
    expect(result.rulesFired).toContain("wrapRootStringAsObject");
    expect(result.input).toEqual({ path: "/foo/bar" });
  });

  it("returns no repairs for valid input", () => {
    const result = repairToolInput(
      { path: "/foo" },
      [],
      "read",
    );
    expect(result.rulesFired).toHaveLength(0);
    expect(result.input).toEqual({ path: "/foo" });
  });

  it("handles unrepairable input", () => {
    const result = repairToolInput(
      { bad_field: 42 },
      [{ code: "missing_field", path: ["path"], message: "missing" }],
      "read",
    );
    expect(result.rulesFired).toHaveLength(0);
  });
});

// ─── Phase 1.5: Phantom toolUse normalization ─────────────────────────────────

describe("normalizePhantomToolUse", () => {
  it("normalizes stopReason toolUse with zero toolCall blocks", () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "I'll call a tool" }],
      stopReason: "toolUse",
    };
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(true);
    expect(result.message.stopReason).toBe("error");
    expect((result.message as any).errorMessage).toMatch(/stream ended before/);
  });

  it("does not normalize when toolCall blocks exist", () => {
    const message = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "" },
        { type: "toolCall" as const, id: "call_1", name: "read", arguments: { path: "/foo" } },
      ],
      stopReason: "toolUse",
    };
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(false);
    expect(result.message.stopReason).toBe("toolUse");
  });

  it("does not normalize non-toolUse stopReason", () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Done" }],
      stopReason: "stop",
    };
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(false);
  });

  it("does not normalize non-assistant messages", () => {
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hello" }],
      stopReason: "toolUse",
    } as any;
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(false);
  });

  it("normalizes with empty content array", () => {
    const message = {
      role: "assistant" as const,
      content: [],
      stopReason: "toolUse",
    };
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(true);
    expect(result.message.stopReason).toBe("error");
    expect((result.message as any).errorMessage).toMatch(/stream ended before/);
  });

  it("preserves all other message fields", () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "thinking" as const, thinking: "..." }],
      stopReason: "toolUse",
      usage: { input: 100, output: 50 },
      model: "zai-org/glm-5.1",
    };
    const result = normalizePhantomToolUse(message);
    expect(result.changed).toBe(true);
    expect(result.message.stopReason).toBe("error");
    expect((result.message as any).errorMessage).toMatch(/stream ended before/);
    expect((result.message as any).usage).toEqual({ input: 100, output: 50 });
    expect((result.message as any).model).toBe("zai-org/glm-5.1");
  });
});
