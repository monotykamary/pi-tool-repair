import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import toolRepair from "../tool-repair.js";

interface RegisteredHandlers {
  message_end?: (event: any, context: any) => unknown;
  before_provider_request?: (event: any, context: any) => unknown;
  tool_call?: (event: any, context: any) => unknown;
}

const createApi = (
  activeTools: string[],
  tools: Array<{ name: string; parameters: ReturnType<typeof Type.Object> }>,
): { api: ExtensionAPI; handlers: RegisteredHandlers } => {
  const handlers: RegisteredHandlers = {};
  const api = {
    on(name: keyof RegisteredHandlers, handler: (event: any, context: any) => unknown) {
      handlers[name] = handler;
    },
    getActiveTools: () => activeTools,
    getAllTools: () => tools.map((tool) => ({
      ...tool,
      description: tool.name,
      promptGuidelines: [],
      sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
    })),
  } as unknown as ExtensionAPI;
  return { api, handlers };
};

describe("extension prevalidation integration", () => {
  it("registers message-end repair instead of the post-validation tool_call hook", () => {
    const { api, handlers } = createApi([], []);
    toolRepair(api);
    expect(handlers.before_provider_request).toBeTypeOf("function");
    expect(handlers.message_end).toBeTypeOf("function");
    expect(handlers.tool_call).toBeUndefined();
  });

  it("repairs active direct-tool arguments on the finalized assistant message", () => {
    const readSchema = Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
    });
    const { api, handlers } = createApi(["read"], [{ name: "read", parameters: readSchema }]);
    toolRepair(api);

    const result = handlers.message_end?.({
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { file_path: "/x", offset: null },
        }],
        stopReason: "toolUse",
      },
    }, { model: { id: "claude-sonnet-4" } }) as { message: { content: Array<Record<string, unknown>> } };

    expect(result.message.content[0]?.arguments).toEqual({ path: "/x" });
  });

  it("repairs fabric_exec when it is the only active model-facing tool", () => {
    const fabricSchema = Type.Object({
      code: Type.String(),
      display: Type.Optional(Type.String()),
    });
    const { api, handlers } = createApi(
      ["fabric_exec"],
      [{ name: "fabric_exec", parameters: fabricSchema }],
    );
    toolRepair(api);

    const result = handlers.message_end?.({
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_1",
          name: "fabric_exec",
          arguments: { code: ["return", "  1;"], display: null },
        }],
        stopReason: "toolUse",
      },
    }, { model: { id: "claude-sonnet-4" } }) as { message: { content: Array<Record<string, unknown>> } };

    expect(result.message.content[0]?.arguments).toEqual({ code: "return\n  1;" });
  });
});
