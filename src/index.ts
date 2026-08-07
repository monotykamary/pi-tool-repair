/**
 * Shared types, constants, and pure functions for pi-tool-repair.
 *
 * All repair logic lives here so it can be unit-tested without
 * pi ExtensionAPI or event hooks.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

import type { MinimalAssistantMessage } from "./grammar-repair.js";
import { Value } from "typebox/value";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface RepairConfig {
  debug: boolean;
  anchorBleedModels: RegExp[];
  grammarLeakModels: RegExp[];
  fieldAliases: Record<string, Record<string, string[]>>;
  stringArgTools: Record<string, { field: string; shape: "string" | "array" }>;
}

export const DEFAULT_CONFIG: RepairConfig = {
  debug: Boolean(process.env.PI_TOOL_REPAIR_DEBUG),
  anchorBleedModels: [
    /kimi-k2/i,
    /minimax/i,
    /glm/i,
  ],
  grammarLeakModels: [
    /glm/i,
  ],
  fieldAliases: {
    read: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath",
      ],
      offset: ["start"],
      limit: ["max"],
    },
    grep: {
      pattern: ["query", "regex", "search", "q", "expression", "text"],
      glob: ["globPattern"],
      ignoreCase: ["ic", "caseInsensitive"],
      context: ["ctx"],
      limit: ["max"],
    },
    write: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath",
      ],
      content: ["text", "body", "data", "contents", "fileContent"],
    },
    edit: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath",
      ],
      oldText: [
        "old_string", "oldString", "old", "old_str", "oldStr", "from",
        "old_value", "old_text", "oldContent", "old_content",
      ],
      newText: [
        "new_string", "newString", "new", "replacement", "new_str", "newStr", "to",
        "new_value", "new_text", "newContent", "new_content",
      ],
    },
    ls: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath",
        "directory", "dir", "folder", "directoryPath",
      ],
      limit: ["max"],
    },
    find: {
      pattern: ["query", "regex", "glob", "expression", "search", "include", "name", "filename"],
      limit: ["max"],
    },
    bash: {
      command: ["cmd", "shell", "cmdline", "script", "commandLine"],
    },
  },
  stringArgTools: {
    grep: { field: "pattern", shape: "string" },
    find: { field: "pattern", shape: "string" },
    bash: { field: "command", shape: "string" },
    read: { field: "path", shape: "string" },
    ls: { field: "path", shape: "string" },
    fabric_exec: { field: "code", shape: "string" },
  },
};

// ─── Phase 0: Schema Poisoning Defense ────────────────────────────────────────

export function hasAnchorBleedBug(model: { id?: string } | null | undefined): boolean {
  if (!model || !model.id) return false;
  return DEFAULT_CONFIG.anchorBleedModels.some((re) => re.test(model.id!));
}

export function hasGrammarLeakBug(model: { id?: string } | null | undefined): boolean {
  if (!model || !model.id) return false;
  return DEFAULT_CONFIG.grammarLeakModels.some((re) => re.test(model.id!));
}

export function sanitizePattern(pattern: string): string | undefined {
  if (pattern.includes("|") && (pattern.includes("^") || pattern.includes("$"))) {
    return undefined;
  }
  const stripped = pattern.replace(/\^|\$/g, "");
  return stripped.length > 0 ? stripped : undefined;
}

export function sanitizeSchemaAnchors(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaAnchors);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "pattern" && typeof value === "string") {
      const sanitized = sanitizePattern(value);
      if (sanitized !== undefined) result[key] = sanitized;
    } else if (value && typeof value === "object") {
      result[key] = sanitizeSchemaAnchors(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function stripAnchorBleedInPlace(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      let s = value;
      while (s.startsWith("^")) s = s.slice(1);
      while (s.endsWith("$")) s = s.slice(0, -1);
      if (s !== value) {
        obj[key] = s;
        changed = true;
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          let s = item;
          while (s.startsWith("^")) s = s.slice(1);
          while (s.endsWith("$")) s = s.slice(0, -1);
          if (s !== item) {
            value[i] = s;
            changed = true;
          }
        } else if (item && typeof item === "object") {
          if (stripAnchorBleedInPlace(item as Record<string, unknown>)) changed = true;
        }
      }
    } else if (value && typeof value === "object") {
      if (stripAnchorBleedInPlace(value as Record<string, unknown>)) changed = true;
    }
  }
  return changed;
}

// Leaked grammar markers from GLM/ChatGLM style tool-call grammars.
// These can end up as literal prefixes/suffixes on parsed object keys
// or string values instead of being interpreted as XML tags.
const GRAMMAR_TOKEN_LEAKS = [
  { tag: "<arg_key>", at: "start" as const },
  { tag: "</arg_key>", at: "end" as const },
  { tag: "<arg_value>", at: "start" as const },
  { tag: "</arg_value>", at: "end" as const },
];

const stripBoundaryGrammarTokens = (value: string): string | undefined => {
  let stripped = value;
  let changed = false;
  for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
    if (at === "start" && stripped.startsWith(tag)) {
      stripped = stripped.slice(tag.length);
      changed = true;
    } else if (at === "end" && stripped.endsWith(tag)) {
      stripped = stripped.slice(0, -tag.length);
      changed = true;
    }
  }
  return changed ? stripped.trim() : undefined;
};

export function stripGrammarTokenLeaksInPlace(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const newKey = stripBoundaryGrammarTokens(key) ?? key;

    if (newKey !== key) {
      obj[newKey] = value;
      delete obj[key];
      changed = true;
    }

    if (typeof value === "string") {
      const stripped = stripBoundaryGrammarTokens(value);
      if (stripped !== undefined) {
        obj[newKey] = stripped;
        changed = true;
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          const stripped = stripBoundaryGrammarTokens(item);
          if (stripped !== undefined) {
            value[i] = stripped;
            changed = true;
          }
        } else if (item && typeof item === "object") {
          if (stripGrammarTokenLeaksInPlace(item as Record<string, unknown>)) changed = true;
        }
      }
    } else if (value && typeof value === "object") {
      if (stripGrammarTokenLeaksInPlace(value as Record<string, unknown>)) changed = true;
    }
  }
  return changed;
}

// ─── Phase 2: Repair Rules ────────────────────────────────────────────────────

export interface RepairResult {
  hint: string;
  ruleName: string;
}

export interface RepairContext {
  toolName: string;
  parent: Record<string, unknown>;
  key: string;
  value: unknown;
  issue: ValidationIssue;
}

export interface ValidationIssue {
  code: string;
  expected?: string;
  received?: string;
  path: (string | number)[];
  message: string;
}

// Rule 1: renameAliasedField
//
// Two scenarios:
//   A) The issue path points to an alias key (e.g. "file_path") and the canonical
//      is missing → rename alias → canonical.
//   B) The issue path points to a canonical key marked missing (e.g. "path") and
//      the parent contains an alias for it → rename alias → canonical.
export function renameAliasedField(ctx: RepairContext): RepairResult | false {
  const aliases = DEFAULT_CONFIG.fieldAliases[ctx.toolName];
  if (!aliases) return false;

  // Scenario A: ctx.key is an alias (appears in an alias list)
  const canonicalFromAlias = Object.entries(aliases).find(
    ([, aliasList]) => aliasList.includes(ctx.key),
  )?.[0];
  if (canonicalFromAlias && !(canonicalFromAlias in ctx.parent)) {
    const existing = ctx.parent[ctx.key];
    if (existing != null && (typeof existing !== "string" || existing !== "")) {
      ctx.parent[canonicalFromAlias] = existing;
      delete ctx.parent[ctx.key];
      return {
        ruleName: "renameAliasedField",
        hint: `Renamed \`${ctx.key}\` to \`${canonicalFromAlias}\` for tool "${ctx.toolName}". ` +
          `Use \`${canonicalFromAlias}\` next time — \`${ctx.key}\` is not a valid field for this tool.`,
      };
    }
  }

  // Scenario B: ctx.key is a canonical name that's missing, and the parent has an alias for it
  if (ctx.issue.code === "missing_field" && aliases[ctx.key]) {
    const aliasList = aliases[ctx.key];
    const alias = aliasList.find((a) => a in ctx.parent && ctx.parent[a] != null);
    if (alias) {
      const value = ctx.parent[alias];
      if (typeof value !== "string" || value !== "") {
        // Remove the key so the missing_field issue resolves on re-validation
        delete (ctx.parent as Record<string, unknown>)["__rename_placeholder__"];
        ctx.parent[ctx.key] = value;
        delete ctx.parent[alias];
        return {
          ruleName: "renameAliasedField",
          hint: `Renamed \`${alias}\` to \`${ctx.key}\` for tool "${ctx.toolName}". ` +
            `Use \`${ctx.key}\` next time — \`${alias}\` is not a valid field for this tool.`,
        };
      }
    }
  }

  return false;
}

// Rule 2: dropNullOrUndefined
export function dropNullOrUndefined(ctx: RepairContext): RepairResult | false {
  if (!(ctx.key in ctx.parent)) return false;
  if (ctx.value != null) return false;
  delete ctx.parent[ctx.key];
  const kind = ctx.value === null ? "null" : "undefined";
  return {
    ruleName: "dropNullOrUndefined",
    hint: `Dropped ${kind} \`${ctx.key}\` from tool "${ctx.toolName}". ` +
      `Optional fields can be omitted entirely rather than sent as ${kind}.`,
  };
}

// Rule 3: dropEmptyObjectPlaceholder
export function dropEmptyObjectPlaceholder(ctx: RepairContext): RepairResult | false {
  if (!(ctx.key in ctx.parent)) return false;
  if (typeof ctx.value !== "object" || ctx.value === null || Array.isArray(ctx.value)) return false;
  if (Object.keys(ctx.value as object).length !== 0) return false;
  delete ctx.parent[ctx.key];
  return {
    ruleName: "dropEmptyObjectPlaceholder",
    hint: `Dropped empty \`{}\` placeholder from \`${ctx.key}\` for tool "${ctx.toolName}". ` +
      `Send an actual array (or omit the field) next time.`,
  };
}

// Rule 4: parseJsonStringifiedArray
export function tryParseJsonArray(str: string): unknown[] | null {
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonStringifiedArray(ctx: RepairContext): RepairResult | false {
  if (typeof ctx.value !== "string") return false;
  const parsed = tryParseJsonArray(ctx.value);
  if (parsed !== null) {
    ctx.parent[ctx.key] = parsed;
    return {
      ruleName: "parseJsonStringifiedArray",
      hint: `Parsed JSON-stringified array for \`${ctx.key}\` in tool "${ctx.toolName}". ` +
        `Send the array literal directly (e.g. ["a","b"]) next time, not a string.`,
    };
  }
  return false;
}

// Rule 5: wrapBareStringAsArray
export function wrapBareStringAsArray(ctx: RepairContext): RepairResult | false {
  if (ctx.issue.code !== "invalid_type") return false;
  if (ctx.issue.expected !== "array") return false;
  if (typeof ctx.value !== "string") return false;
  ctx.parent[ctx.key] = [ctx.value];
  return {
    ruleName: "wrapBareStringAsArray",
    hint: `Wrapped your bare string in a single-element array for \`${ctx.key}\` ` +
      `in tool "${ctx.toolName}". Send an array (e.g. ["foo"]) next time, not a single string.`,
  };
}

// Ordered repair pipeline for per-issue fixes
export const REPAIR_RULES: Array<(ctx: RepairContext) => RepairResult | false> = [
  renameAliasedField,
  dropNullOrUndefined,
  dropEmptyObjectPlaceholder,
  parseJsonStringifiedArray,
  wrapBareStringAsArray,
];

// ─── Root-Level Repair: wrapRootStringAsObject ────────────────────────────────

export function wrapRootStringAsObject(
  input: unknown,
  toolName: string,
): { wrapped: Record<string, unknown>; hint: string } | undefined {
  if (typeof input !== "string") return undefined;
  const mapping = DEFAULT_CONFIG.stringArgTools[toolName];
  if (!mapping) return undefined;

  const wrapped = mapping.shape === "string"
    ? { [mapping.field]: input }
    : { [mapping.field]: [input] };

  return {
    wrapped,
    hint: `Interpreted your bare string as the \`${mapping.field}\` argument ` +
      `for tool "${toolName}". Call this tool with an object, not a bare string, next time.`,
  };
}

// ─── Phase 1.5: Phantom toolUse normalization ───────────────────────────────
//
// Some providers (notably vLLM-backed endpoints like z.ai and Lilac) intermittently
// emit finish_reason: "tool_calls" without any delta.tool_calls chunks. Pi maps this
// to stopReason: "toolUse" with zero toolCall blocks — a broken state where the
// agent loop thinks it should execute tools but has nothing to run, causing an
// "abrupt stop". Detect and normalize to stopReason: "stop" so the agent exits
// cleanly.

export interface PhantomToolUseResult {
  changed: boolean;
  message: MinimalAssistantMessage;
}

export function normalizePhantomToolUse(
  message: MinimalAssistantMessage,
): PhantomToolUseResult {
  if (message.role !== "assistant") return { changed: false, message };
  if (message.stopReason !== "toolUse") return { changed: false, message };

  const content = message.content;
  const hasToolCalls = Array.isArray(content) &&
    content.some((block) => typeof block === "object" && block !== null && !Array.isArray(block) && (block as Record<string, unknown>).type === "toolCall");

  if (hasToolCalls) return { changed: false, message };

  return {
    changed: true,
    message: {
      ...message,
      stopReason: "error",
      errorMessage: "stream ended before tool_calls were received (vLLM phantom tool_use)",
    },
  };
}

// ─── Deep clone ───────────────────────────────────────────────────────────────

export function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = deepClone(v);
  }
  return result;
}

// ─── Walk to parent container ─────────────────────────────────────────────────

export function walkToParent(
  root: Record<string, unknown>,
  path: (string | number)[],
): Record<string, unknown> | undefined {
  const parentPath = path.slice(0, -1);
  const result = parentPath.reduce(
    (acc: unknown, key) => {
      if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    },
    root as unknown,
  );
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return undefined;
}

// ─── Core Repair Logic ────────────────────────────────────────────────────────

export interface RepairOutcome {
  input: unknown;
  rulesFired: string[];
  hints: string[];
}

export function repairToolInput(
  rawInput: unknown,
  issues: ValidationIssue[],
  toolName: string,
): RepairOutcome {
  const wrapResult = wrapRootStringAsObject(rawInput, toolName);
  if (wrapResult !== undefined) {
    return {
      input: wrapResult.wrapped,
      rulesFired: ["wrapRootStringAsObject"],
      hints: [wrapResult.hint],
    };
  }

  if (rawInput === null || typeof rawInput !== "object") {
    return { input: rawInput, rulesFired: [], hints: [] };
  }

  const cloned = deepClone(rawInput) as Record<string, unknown>;
  const rulesFired: string[] = [];
  const hints: string[] = [];

  for (const issue of issues) {
    const path = issue.path;
    if (path.length === 0) continue;

    const parent = walkToParent(cloned, path);
    if (parent === undefined) continue;

    const key = path[path.length - 1];
    if (typeof key !== "string") continue;

    const value = parent[key as string];

    const ctx: RepairContext = {
      toolName,
      parent,
      key,
      value,
      issue,
    };

    for (const rule of REPAIR_RULES) {
      const result = rule(ctx);
      if (result !== false) {
        if (!rulesFired.includes(result.ruleName)) rulesFired.push(result.ruleName);
        hints.push(result.hint);
        break;
      }
    }
  }

  return rulesFired.length === 0
    ? { input: rawInput, rulesFired: [], hints: [] }
    : { input: cloned, rulesFired, hints };
}

// ─── Schema validation for built-in tools ─────────────────────────────────────

export interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  items?: { type: string };
}

export type ToolSchema = Record<string, SchemaField>;

export const BUILTIN_SCHEMAS: Record<string, ToolSchema> = {
  read: {
    path: { type: "string", required: true },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  write: {
    path: { type: "string", required: true },
    content: { type: "string", required: true },
  },
  edit: {
    path: { type: "string", required: true },
    edits: { type: "array", required: true, items: { type: "object" } },
  },
  bash: {
    command: { type: "string", required: true },
    timeout: { type: "number" },
  },
  grep: {
    pattern: { type: "string", required: true },
    path: { type: "string" },
    glob: { type: "string" },
    ignoreCase: { type: "boolean" },
    literal: { type: "boolean" },
    context: { type: "number" },
    limit: { type: "number" },
  },
  find: {
    pattern: { type: "string", required: true },
    path: { type: "string" },
    limit: { type: "number" },
  },
  ls: {
    path: { type: "string" },
    limit: { type: "number" },
  },
};

export function validateAgainstSchema(
  input: Record<string, unknown>,
  schema: ToolSchema,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    const value = input[fieldName];

    if (value === undefined || value === null) {
      if (fieldDef.required) {
        issues.push({
          code: "missing_field",
          path: [fieldName],
          message: `Required field "${fieldName}" is missing`,
        });
      } else if (value === null) {
        issues.push({
          code: "invalid_type",
          expected: fieldDef.type,
          received: "null",
          path: [fieldName],
          message: `Optional field "${fieldName}" is null — omit it instead`,
        });
      }
      continue;
    }

    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== fieldDef.type) {
      issues.push({
        code: "invalid_type",
        expected: fieldDef.type,
        received: actualType,
        path: [fieldName],
        message: `Field "${fieldName}" expected ${fieldDef.type}, got ${actualType}`,
      });
    }

    if (fieldDef.type === "array" && typeof value === "string") {
      issues.push({
        code: "invalid_type",
        expected: "array",
        received: "string",
        path: [fieldName],
        message: `Field "${fieldName}" expected array, got string`,
      });
    }
  }

  return issues;
}


export type LiveToolSchema = {
  name: string;
  parameters: import("typebox").TSchema;
};

export type LiveRepairStatus = "unchanged" | "recovered" | "unrepairable";

export interface LiveToolRepairOutcome {
  toolName: string;
  status: LiveRepairStatus;
  input: unknown;
  repaired?: unknown;
  rulesFired: string[];
  hints: string[];
}

export interface AssistantToolCallRepairResult {
  changed: boolean;
  message: MinimalAssistantMessage;
  repairs: LiveToolRepairOutcome[];
}

const schemaRecord = (schema: unknown): Record<string, unknown> | undefined =>
  isObject(schema) ? schema : undefined;

const schemaProperties = (schema: unknown): Record<string, Record<string, unknown>> => {
  const properties = schemaRecord(schema)?.properties;
  if (!isObject(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1])),
  );
};

const schemaRequired = (schema: unknown): Set<string> => {
  const required = schemaRecord(schema)?.required;
  return new Set(Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : []);
};

const schemaCheck = (schema: import("typebox").TSchema, input: unknown): boolean | undefined => {
  try {
    return Value.Check(schema, input);
  } catch {
    return undefined;
  }
};

const addRule = (
  rulesFired: string[],
  hints: string[],
  ruleName: string,
  hint: string,
): void => {
  if (!rulesFired.includes(ruleName)) rulesFired.push(ruleName);
  hints.push(hint);
};

const firstUsableField = (
  input: Record<string, unknown>,
  names: string[],
): { key: string; value: unknown } | undefined => {
  for (const key of names) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value === null || value === undefined || value === "") continue;
    return { key, value };
  }
  return undefined;
};

const deleteFields = (input: Record<string, unknown>, names: string[]): void => {
  for (const name of names) delete input[name];
};

const repairObjectFromSchema = (
  toolName: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
  rulesFired: string[],
  hints: string[],
  path: string[] = [],
): void => {
  const properties = schemaProperties(schema);
  const required = schemaRequired(schema);
  const aliases = DEFAULT_CONFIG.fieldAliases[toolName] ?? {};

  for (const [canonical, aliasNames] of Object.entries(aliases)) {
    if (!Object.hasOwn(properties, canonical) || Object.hasOwn(input, canonical)) continue;
    const alias = firstUsableField(input, aliasNames.filter((name) => name !== canonical));
    if (!alias) continue;
    input[canonical] = alias.value;
    delete input[alias.key];
    addRule(
      rulesFired,
      hints,
      "renameAliasedField",
      `Renamed \`${[...path, alias.key].join(".")}\` to \`${[...path, canonical].join(".")}\` for tool "${toolName}".`,
    );
  }

  if (toolName === "edit" && path.length === 0 && Object.hasOwn(properties, "edits") && !Object.hasOwn(input, "edits")) {
    const oldNames = ["oldText", ...(aliases.oldText ?? []).filter((name) => name !== "oldText")];
    const newNames = ["newText", ...(aliases.newText ?? []).filter((name) => name !== "newText")];
    const oldField = firstUsableField(input, oldNames);
    const newField = firstUsableField(input, newNames);
    if (typeof oldField?.value === "string" && typeof newField?.value === "string") {
      deleteFields(input, oldNames);
      deleteFields(input, newNames);
      input.edits = [{ oldText: oldField.value, newText: newField.value }];
      addRule(
        rulesFired,
        hints,
        "wrapLegacyEditFields",
        "Moved legacy edit text fields into the current `edits` array.",
      );
    }
  }

  if (
    toolName === "bash" &&
    path.length === 0 &&
    !Object.hasOwn(input, "timeout") &&
    Object.hasOwn(input, "timeoutMs")
  ) {
    const timeoutMs = input.timeoutMs;
    if (timeoutMs !== null && timeoutMs !== undefined && Number.isFinite(Number(timeoutMs))) {
      input.timeout = Number(timeoutMs) / 1000;
      delete input.timeoutMs;
      addRule(
        rulesFired,
        hints,
        "convertTimeoutMilliseconds",
        "Converted `bash.timeoutMs` from milliseconds to `timeout` seconds.",
      );
    }
  }

  if (
    toolName === "fabric_exec" &&
    path.length === 0 &&
    schemaRecord(properties.code)?.type === "string" &&
    Array.isArray(input.code) &&
    input.code.every((line) => typeof line === "string")
  ) {
    input.code = input.code.join("\n");
    addRule(
      rulesFired,
      hints,
      "joinStringArray",
      "Joined the `fabric_exec.code` string array with newlines.",
    );
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    const fieldPath = [...path, key].join(".");

    if ((value === null || value === undefined) && !required.has(key)) {
      delete input[key];
      addRule(
        rulesFired,
        hints,
        "dropNullOrUndefined",
        `Dropped optional ${value === null ? "null" : "undefined"} \`${fieldPath}\` from tool "${toolName}".`,
      );
      continue;
    }

    if (
      propertySchema.type === "number" &&
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      input[key] = Number(value);
      addRule(
        rulesFired,
        hints,
        "coerceNumericString",
        `Converted numeric string in ${fieldPath} for tool "${toolName}".`,
      );
      continue;
    }

    if (propertySchema.type === "array") {
      if (isObject(value) && Object.keys(value).length === 0) {
        delete input[key];
        addRule(
          rulesFired,
          hints,
          "dropEmptyObjectPlaceholder",
          `Dropped empty object placeholder from array field \`${fieldPath}\` for tool "${toolName}".`,
        );
        continue;
      }
      if (typeof value === "string") {
        const parsed = tryParseJsonArray(value);
        input[key] = parsed ?? [value];
        addRule(
          rulesFired,
          hints,
          parsed ? "parseJsonStringifiedArray" : "wrapBareStringAsArray",
          parsed
            ? `Parsed JSON-stringified array in \`${fieldPath}\` for tool "${toolName}".`
            : `Wrapped bare string in an array for \`${fieldPath}\` in tool "${toolName}".`,
        );
      }
      const arrayValue = input[key];
      const itemSchema = schemaRecord(propertySchema.items);
      if (Array.isArray(arrayValue) && itemSchema) {
        for (let index = 0; index < arrayValue.length; index++) {
          const item = arrayValue[index];
          if (isObject(item)) {
            repairObjectFromSchema(
              toolName,
              itemSchema,
              item,
              rulesFired,
              hints,
              [...path, key, String(index)],
            );
          }
        }
      }
      continue;
    }

    if (propertySchema.type === "object" && isObject(value)) {
      repairObjectFromSchema(toolName, propertySchema, value, rulesFired, hints, [...path, key]);
    }
  }
};

export function repairInputAgainstLiveSchema(
  toolName: string,
  rawInput: unknown,
  schema: import("typebox").TSchema,
): LiveToolRepairOutcome {
  const initial = schemaCheck(schema, rawInput);
  if (initial === undefined) {
    return { toolName, status: "unchanged", input: rawInput, rulesFired: [], hints: [] };
  }

  const wrapped = initial ? undefined : wrapRootStringAsObject(rawInput, toolName);
  const candidate = wrapped ? wrapped.wrapped : deepClone(rawInput);
  const rulesFired = wrapped ? ["wrapRootStringAsObject"] : [];
  const hints = wrapped ? [wrapped.hint] : [];

  const objectSchema = schemaRecord(schema);
  if (isObject(candidate) && objectSchema) {
    repairObjectFromSchema(toolName, objectSchema, candidate, rulesFired, hints);
  }

  if (rulesFired.length === 0) {
    return {
      toolName,
      status: initial ? "unchanged" : "unrepairable",
      input: rawInput,
      rulesFired,
      hints,
    };
  }

  return schemaCheck(schema, candidate) === true
    ? {
        toolName,
        status: "recovered",
        input: rawInput,
        repaired: candidate,
        rulesFired,
        hints,
      }
    : {
        toolName,
        status: "unrepairable",
        input: rawInput,
        repaired: candidate,
        rulesFired,
        hints,
      };
}

export function repairAssistantToolCallInputs(
  message: MinimalAssistantMessage,
  tools: readonly LiveToolSchema[],
): AssistantToolCallRepairResult {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return { changed: false, message, repairs: [] };
  }

  const schemas = new Map(tools.map((tool) => [tool.name, tool.parameters]));
  const repairs: LiveToolRepairOutcome[] = [];
  let changed = false;
  const content = message.content.map((part) => {
    if (!isObject(part) || part.type !== "toolCall" || typeof part.name !== "string") return part;
    const schema = schemas.get(part.name);
    if (!schema) return part;
    const outcome = repairInputAgainstLiveSchema(part.name, part.arguments, schema);
    if (outcome.status !== "unchanged") repairs.push(outcome);
    if (outcome.status !== "recovered") return part;
    changed = true;
    return { ...part, arguments: outcome.repaired };
  });

  return changed
    ? { changed: true, message: { ...message, content }, repairs }
    : { changed: false, message, repairs };
}

// Logging

export * from "./grammar-repair.js";

export function logRepair(
  toolName: string,
  outcome: "recovered" | "unrepairable",
  details: { rulesFired: string[]; hints: string[]; input: unknown; repaired?: unknown },
): void {
  if (!DEFAULT_CONFIG.debug) return;
  const rules = details.rulesFired.length === 0 ? "none" : details.rulesFired.join(",");
  const lines = [`[pi-tool-repair] tool=${toolName} outcome=${outcome} rules=${rules}`];
  lines.push(`  input: ${JSON.stringify(details.input)}`);
  if (details.repaired !== undefined && details.repaired !== details.input) {
    lines.push(`  repaired: ${JSON.stringify(details.repaired)}`);
  }
  details.hints.forEach((h, i) => lines.push(`  hint[${i}]: ${h}`));
  process.stderr.write(lines.join("\n") + "\n");
}
