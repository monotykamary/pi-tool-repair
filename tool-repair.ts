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
  hasAnchorBleedBug,
  sanitizeSchemaAnchors,
  stripAnchorBleedInPlace,
  wrapRootStringAsObject,
  repairToolInput,
  validateAgainstSchema,
  logRepair,
  BUILTIN_SCHEMAS,
} from "./src/index.js";

export default function (pi: ExtensionAPI) {
  // Phase 0: Schema poisoning defense (before_provider_request)
  // Strip regex anchors from JSON Schema patterns for models where they leak
  pi.on("before_provider_request", (event, ctx) => {
    if (!hasAnchorBleedBug(ctx.model)) return;

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

  // Phase 2: Validate-then-repair (tool_call)
  pi.on("tool_call", (event, ctx) => {
    const toolName = event.toolName;
    const input = (event as any).input;

    // Defense-in-depth: strip anchor-bleed from generated values
    if (hasAnchorBleedBug(ctx.model)) {
      if (input && typeof input === "object") {
        stripAnchorBleedInPlace(input);
      }
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
