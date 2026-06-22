/**
 * Shared types, constants, and pure functions for pi-tool-repair.
 *
 * All repair logic lives here so it can be unit-tested without
 * pi ExtensionAPI or event hooks.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

import type { MinimalAssistantMessage } from "./grammar-repair.js";

export interface RepairConfig {
  debug: boolean;
  anchorBleedModels: RegExp[];
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
  fieldAliases: {
    read: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath",
      ],
    },
    grep: {
      pattern: ["query", "regex", "search", "q", "expression", "text"],
    },
    write: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile",
      ],
      content: ["text", "body", "data", "contents", "fileContent"],
    },
    edit: {
      path: [
        "absolutePath", "file_path", "filePath", "filepath", "pathname",
        "target_file", "targetFile",
      ],
      oldText: [
        "old_string", "oldString", "old", "old_str", "oldStr", "from",
        "old_value", "oldText", "old_text", "oldContent", "old_content",
      ],
      newText: [
        "new_string", "newString", "new", "new_str", "newStr", "to",
        "new_value", "newText", "new_text", "newContent", "new_content",
      ],
    },
    ls: {
      path: ["absolutePath", "directory", "dir", "folder", "directoryPath"],
    },
    find: {
      pattern: ["query", "glob", "expression", "search", "include"],
    },
    bash: {
      command: ["cmd", "shell", "script", "commandLine"],
    },
  },
  stringArgTools: {
    grep: { field: "pattern", shape: "string" },
    find: { field: "pattern", shape: "string" },
    bash: { field: "command", shape: "string" },
    read: { field: "path", shape: "string" },
    ls: { field: "path", shape: "string" },
  },
};

// ─── Phase 0: Schema Poisoning Defense ────────────────────────────────────────

export function hasAnchorBleedBug(model: { id?: string } | null | undefined): boolean {
  if (!model || !model.id) return false;
  return DEFAULT_CONFIG.anchorBleedModels.some((re) => re.test(model.id!));
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

export function stripAnchorBleedInPlace(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      let s = value;
      while (s.startsWith("^")) s = s.slice(1);
      while (s.endsWith("$")) s = s.slice(0, -1);
      obj[key] = s;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          let s = item;
          while (s.startsWith("^")) s = s.slice(1);
          while (s.endsWith("$")) s = s.slice(0, -1);
          value[i] = s;
        } else if (item && typeof item === "object") {
          stripAnchorBleedInPlace(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === "object") {
      stripAnchorBleedInPlace(value as Record<string, unknown>);
    }
  }
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

export function stripGrammarTokenLeaksInPlace(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    let newKey = key;
    for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
      if (at === "start" && newKey.startsWith(tag)) {
        newKey = newKey.slice(tag.length);
      } else if (at === "end" && newKey.endsWith(tag)) {
        newKey = newKey.slice(0, -tag.length);
      }
    }
    newKey = newKey.trim();

    if (newKey !== key) {
      obj[newKey] = value;
      delete obj[key];
    }

    if (typeof value === "string") {
      let s = value;
      for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
        if (at === "start" && s.startsWith(tag)) {
          s = s.slice(tag.length);
        } else if (at === "end" && s.endsWith(tag)) {
          s = s.slice(0, -tag.length);
        }
      }
      obj[newKey] = s.trim();
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          let s = item;
          for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
            if (at === "start" && s.startsWith(tag)) {
              s = s.slice(tag.length);
            } else if (at === "end" && s.endsWith(tag)) {
              s = s.slice(0, -tag.length);
            }
          }
          value[i] = s.trim();
        } else if (item && typeof item === "object") {
          stripGrammarTokenLeaksInPlace(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === "object") {
      stripGrammarTokenLeaksInPlace(value as Record<string, unknown>);
    }
  }
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
    oldText: { type: "string", required: true },
    newText: { type: "string", required: true },
    replaceAll: { type: "boolean" },
  },
  bash: {
    command: { type: "string", required: true },
    timeout: { type: "number" },
  },
  grep: {
    pattern: { type: "string", required: true },
    include: { type: "array", items: { type: "string" } },
  },
  find: {
    pattern: { type: "string", required: true },
  },
  ls: {
    path: { type: "string" },
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

// ─── Logging ──────────────────────────────────────────────────────────────────

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
