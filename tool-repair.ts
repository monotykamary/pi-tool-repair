/**
 * Tool Input Repair Extension
 *
 * Repairs provider-level schema poisoning and malformed assistant tool calls
 * before Pi validates them. Valid inputs pass through unchanged; attempted
 * argument repairs are committed only when they satisfy the live tool schema.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  hasAnchorBleedBug,
  hasGrammarLeakBug,
  sanitizeSchemaAnchors,
  stripAnchorBleedInPlace,
  stripGrammarTokenLeaksInPlace,
  logRepair,
  loadGrammarRepairConfig,
  repairAssistantMessageGrammarLeaks,
  repairAssistantToolCallInputs,
  normalizePhantomToolUse,
  type MinimalAssistantMessage,
} from "./src/index.js";

function safeGetModel(ctx: { model?: any }): any | undefined {
  try {
    return ctx.model;
  } catch {
    return undefined;
  }
}

function safeGetActiveTools(pi: ExtensionAPI): string[] {
  try {
    return pi.getActiveTools();
  } catch {
    return [];
  }
}

function safeGetActiveToolSchemas(pi: ExtensionAPI) {
  try {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools()
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({ name: tool.name, parameters: tool.parameters }));
  } catch {
    return [];
  }
}

const toolCallArguments = (message: MinimalAssistantMessage): Record<string, unknown>[] => {
  if (!Array.isArray(message.content)) return [];
  const argumentsList: Record<string, unknown>[] = [];
  for (const part of message.content) {
    if (
      part && typeof part === "object" && !Array.isArray(part) &&
      (part as Record<string, unknown>).type === "toolCall"
    ) {
      const args = (part as Record<string, unknown>).arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        argumentsList.push(args as Record<string, unknown>);
      }
    }
  }
  return argumentsList;
};

export default function (pi: ExtensionAPI) {
  const grammarRepairConfig = loadGrammarRepairConfig();

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

    if (modified) return payload;
  });

  // Pi 0.84 prepares and validates tool arguments before `tool_call`, so raw
  // argument recovery must happen on the finalized assistant message instead.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    let message = event.message as unknown as MinimalAssistantMessage;
    let changed = false;
    const model = safeGetModel(ctx);

    for (const args of toolCallArguments(message)) {
      if (model && hasGrammarLeakBug(model) && stripGrammarTokenLeaksInPlace(args)) changed = true;
      if (model && hasAnchorBleedBug(model) && stripAnchorBleedInPlace(args)) changed = true;
    }

    if (grammarRepairConfig.enabled) {
      const knownTools = new Set(
        safeGetActiveTools(pi)
          .filter((name): name is string => typeof name === "string" && name.length > 0),
      );
      const grammarResult = repairAssistantMessageGrammarLeaks(
        message,
        grammarRepairConfig,
        knownTools,
      );
      if (grammarResult.changed) {
        message = grammarResult.message;
        changed = true;
        if (grammarRepairConfig.debug) {
          const calls = grammarResult.recoveredCalls
            .map((call) => `${call.grammar}:${call.name}`)
            .join(",") || "none";
          process.stderr.write(
            `[pi-tool-repair] grammar-repair mode=${grammarRepairConfig.mode} ` +
            `stripped=${grammarResult.strippedRanges} recovered=${calls}\n`,
          );
        }
      }
    }

    const inputResult = repairAssistantToolCallInputs(message, safeGetActiveToolSchemas(pi));
    for (const repair of inputResult.repairs) {
      logRepair(repair.toolName, repair.status === "recovered" ? "recovered" : "unrepairable", {
        rulesFired: repair.rulesFired,
        hints: repair.hints,
        input: repair.input,
        ...(repair.repaired !== undefined ? { repaired: repair.repaired } : {}),
      });
    }
    if (inputResult.changed) {
      message = inputResult.message;
      changed = true;
    }

    const phantomResult = normalizePhantomToolUse(message);
    if (phantomResult.changed) {
      message = phantomResult.message;
      changed = true;
      if (DEFAULT_CONFIG.debug) {
        process.stderr.write(
          '[pi-tool-repair] phantom-tooluse: converted stopReason from "toolUse" to retryable error (no toolCall blocks)\n',
        );
      }
    }

    return changed ? { message: message as any } : undefined;
  });
}
