/**
 * Tool Input Repair Extension
 *
 * Validates and repairs common LLM tool-call mistakes before tools execute.
 * Handles the finite set of errors that open models make when calling tools,
 * as documented in the tool-parsing-insight.md analysis of Command Code.
 *
 * Repair pipeline:
 *   Phase 0: Schema poisoning (pre-request, model-specific)
 *     - Strip regex anchors from JSON Schema patterns for models where they
 *       leak into generated values (e.g., Kimi K2 anchor bleed)
 *
 *   Phase 1: Grammar leak repair (message_end hook, opt-in)
 *     - Strip leaked XML/sentinel tool-call grammars from assistant text/thinking
 *     - Recover complete, known-tool calls into pi toolCall blocks
 *
 *   Phase 1.5: Phantom toolUse normalization (message_end hook, always-on)
 *     - Detect stopReason: "toolUse" with zero toolCall blocks
 *     - Convert to a retryable error to trigger pi's auto-retry mechanism
 *     - Guards against vLLM streaming bugs where finish_reason: "tool_calls"
 *       is emitted without any delta.tool_calls chunks
 *
 *   Phase 2: Validate-then-repair (tool_call hook)
 *     - Validate input against the tool's schema
 *     - On failure, walk the validator's issue list and apply targeted repairs
 *     - Re-validate. Surface repair notes to the model.
 *
 * Repair rules (order matters!):
 *   1. wrapRootStringAsObject  — bare string where object expected
 *   2. renameAliasedField       — wrong field name → canonical name
 *   3. dropNullOrUndefined     — null/undefined for optional fields
 *   4. dropEmptyObjectPlaceholder — {} where array expected
 *   5. parseJsonStringifiedArray — '"[\"a\"]"' → ["a"]
 *   6. wrapBareStringAsArray    — "foo" → ["foo"]
 *
 * See tool-parsing-extraction.md for the full reverse-engineered analysis.
 *
 * Usage:
 *   pi -e /path/to/pi-tool-repair
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  hasAnchorBleedBug,
  hasGrammarLeakBug,
  sanitizeSchemaAnchors,
  stripAnchorBleedInPlace,
  stripGrammarTokenLeaksInPlace,
  wrapRootStringAsObject,
  repairToolInput,
  validateAgainstSchema,
  logRepair,
  BUILTIN_SCHEMAS,
  loadGrammarRepairConfig,
  repairAssistantMessageGrammarLeaks,
  normalizePhantomToolUse,
  type MinimalAssistantMessage,
} from "./src/index.js";

// Safely access ctx.model without throwing on stale contexts.
// After session replacement (newSession/fork/switchSession/reload), the
// extension runner invalidates stale contexts and ctx.model throws.
// When that happens, the request belongs to a dead session — bail out.
function safeGetModel(ctx: { model?: any }): any | undefined {
  try {
    return ctx.model;
  } catch {
    return undefined;
  }
}

// Safely call pi.getActiveTools() without throwing on stale contexts.
function safeGetActiveTools(pi: ExtensionAPI): string[] {
  try {
    return pi.getActiveTools();
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  const grammarRepairConfig = loadGrammarRepairConfig();

  // Phase 0: Schema poisoning defense (before_provider_request)
  // Strip regex anchors from JSON Schema patterns for models where they leak
  pi.on("before_provider_request", (event, ctx) => {
    const model = safeGetModel(ctx);
    if (!model || !hasAnchorBleedBug(model)) return;

    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object") return;

    let modified = false;

    const tools = payload.tools;
    if (Array.isArray(tools)) {
      payload.tools = tools.map((tool: any) => {
        if (tool?.function?.parameters) {
          return {
            ...tool,
            function: {
              ...tool.function,
              parameters: sanitizeSchemaAnchors(tool.function.parameters),
            },
          };
        }
        return tool;
      });
      modified = true;
    }

    const responseFormat = payload.response_format as any;
    if (responseFormat?.json_schema?.schema) {
      responseFormat.json_schema.schema = sanitizeSchemaAnchors(responseFormat.json_schema.schema);
      modified = true;
    }

    if (modified) {
      return payload;
    }
  });

  // Phase 1 + 1.5: Grammar leak repair + phantom toolUse normalization (message_end)
  //
  // Phase 1.5 (always-on): Detect stopReason: "toolUse" with zero toolCall blocks
  // and convert to a retryable error (stopReason: "error"). This triggers pi's
  // built-in auto-retry mechanism so the agent re-prompts automatically. This
  // guards against vLLM streaming bugs where finish_reason: "tool_calls" is emitted
  // without any delta.tool_calls chunks.
  //
  // Phase 1 (opt-in): Promote leaked XML/sentinel tool-call grammars from
  // assistant text/thinking into pi toolCall blocks. Configured via
  // ~/.pi/agent/extensions/pi-tool-repair.json.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    const currentMessage = event.message as unknown as MinimalAssistantMessage;

    // Phase 1.4: Strip leaked grammar tokens from existing pi toolCall blocks.
    // These can leak from GLM-style grammars straight into the parsed argument
    // keys (e.g. "<arg_key>command" instead of "command"). We have to repair
    // them here, before pi preflights and validates the tool calls.
    let toolCallArgsChanged = false;
    if (Array.isArray(currentMessage.content)) {
      for (const part of currentMessage.content) {
        if (
          part && typeof part === "object" && !Array.isArray(part) &&
          (part as Record<string, unknown>).type === "toolCall"
        ) {
          const args = (part as Record<string, unknown>).arguments;
          if (
            args && typeof args === "object" && !Array.isArray(args) &&
            stripGrammarTokenLeaksInPlace(args as Record<string, unknown>)
          ) {
            toolCallArgsChanged = true;
          }
        }
      }
    }

    // Phase 1.5: Phantom toolUse normalization (always-on)
    const phantomResult = normalizePhantomToolUse(currentMessage);

    if (phantomResult.changed) {
      if (DEFAULT_CONFIG.debug) {
        process.stderr.write(
          `[pi-tool-repair] phantom-tooluse: converted stopReason from "toolUse" to retryable error (no toolCall blocks)\n`,
        );
      }

      // If grammar repair is also enabled, run it on the normalized message so
      // it can still recover leaked tool calls from the text content. If grammar
      // repair recovers calls, it will set stopReason back to "toolUse".
      if (grammarRepairConfig.enabled) {
        const knownTools = new Set(
          safeGetActiveTools(pi)
            .filter((name): name is string => typeof name === "string" && name.length > 0),
        );
        const grammarResult = repairAssistantMessageGrammarLeaks(
          phantomResult.message,
          grammarRepairConfig,
          knownTools,
        );
        if (grammarResult.changed) {
          if (grammarRepairConfig.debug) {
            const calls = grammarResult.recoveredCalls.map((call) => `${call.grammar}:${call.name}`).join(",") || "none";
            process.stderr.write(
              `[pi-tool-repair] grammar-repair mode=${grammarRepairConfig.mode} ` +
              `stripped=${grammarResult.strippedRanges} recovered=${calls}\n`,
            );
          }
          return { message: grammarResult.message as any };
        }
      }

      return { message: phantomResult.message as any };
    }

    // Phase 1: Grammar leak repair (opt-in)
    if (!grammarRepairConfig.enabled) {
      if (toolCallArgsChanged) return { message: currentMessage as any };
      return;
    }

    const knownTools = new Set(
      safeGetActiveTools(pi)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    const result = repairAssistantMessageGrammarLeaks(
      event.message as unknown as MinimalAssistantMessage,
      grammarRepairConfig,
      knownTools,
    );

    if (!result.changed && !toolCallArgsChanged) return;

    if (grammarRepairConfig.debug) {
      const calls = result.recoveredCalls.map((call) => `${call.grammar}:${call.name}`).join(",") || "none";
      process.stderr.write(
        `[pi-tool-repair] grammar-repair mode=${grammarRepairConfig.mode} ` +
        `stripped=${result.strippedRanges} recovered=${calls}\n`,
      );
    }

    return { message: result.message as any };
  });

  // Phase 2: Validate-then-repair (tool_call)
  pi.on("tool_call", (event, ctx) => {
    const toolName = event.toolName;
    const input = (event as any).input;

    const model = safeGetModel(ctx);

    // Defense-in-depth: strip anchor-bleed from generated values
    if (model && hasAnchorBleedBug(model)) {
      if (input && typeof input === "object") {
        stripAnchorBleedInPlace(input);
      }
    }

    // Strip leaked grammar tokens (e.g. GLM <arg_key>) from parsed tool-call
    // keys/values before the schema sees them. Only for models known to produce
    // grammar token leaks.
    if (input && typeof input === "object" && model && hasGrammarLeakBug(model)) {
      stripGrammarTokenLeaksInPlace(input as Record<string, unknown>);
    }

    // Only repair built-in tools we have schemas for
    const schema = BUILTIN_SCHEMAS[toolName];
    if (!schema) return;

    if (!input || typeof input !== "object") {
      // Root-level: might be a bare string
      if (typeof input === "string") {
        const wrapResult = wrapRootStringAsObject(input, toolName);
        if (wrapResult !== undefined) {
          (event as any).input = wrapResult.wrapped;
          logRepair(toolName, "recovered", {
            rulesFired: ["wrapRootStringAsObject"],
            hints: [wrapResult.hint],
            input,
            repaired: wrapResult.wrapped,
          });
        }
      }
      return;
    }

    // Validate as-is
    const issues = validateAgainstSchema(input, schema);
    if (issues.length === 0) return;

    // Try repairs
    const repairResult = repairToolInput(input, issues, toolName);
    if (repairResult.rulesFired.length === 0) {
      logRepair(toolName, "unrepairable", {
        rulesFired: [],
        hints: [],
        input,
      });
      return;
    }

    // Re-validate repaired input
    const repairedInput = repairResult.input as Record<string, unknown>;
    const postRepairIssues = validateAgainstSchema(repairedInput, schema);
    if (postRepairIssues.length === 0) {
      (event as any).input = repairedInput;
      logRepair(toolName, "recovered", {
        rulesFired: repairResult.rulesFired,
        hints: repairResult.hints,
        input,
        repaired: repairedInput,
      });
    } else {
      logRepair(toolName, "unrepairable", {
        rulesFired: repairResult.rulesFired,
        hints: repairResult.hints,
        input,
        repaired: repairedInput,
      });
    }
  });
}
