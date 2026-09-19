import { describe, expect, it } from "vitest";
import { hasAnchorBleedBug } from "../../src/index.js";

describe("default anchor-bleed model detection", () => {
  it("matches Kimi variants across providers", () => {
    const ids = [
      "kimi-k2-instruct",
      "kimi_k2",
      "moonshotai/kimi-k2",
      "@cf/moonshotai/kimi-k2-instruct",
      "@cf/other/kimi-preview",
    ];

    for (const id of ids) {
      expect(hasAnchorBleedBug({ id }), id).toBe(true);
    }
  });

  it("does not match unrelated models", () => {
    const ids = [
      "claude-sonnet-4",
      "gpt-5.1",
      "qwen3-coder",
      "deepseek-v3",
      "@cf/meta/llama-3.3-70b-instruct",
      "@cf/qwen/qwen2.5-coder-32b",
    ];

    for (const id of ids) {
      expect(hasAnchorBleedBug({ id }), id).toBe(false);
    }
  });

  it("still matches the minimax and glm families", () => {
    for (const id of ["minimax-text-01", "MiniMax-M1", "glm-4.5", "zai/glm-4.6"]) {
      expect(hasAnchorBleedBug({ id }), id).toBe(true);
    }
  });

  it("treats missing model ids as no match", () => {
    expect(hasAnchorBleedBug({})).toBe(false);
    expect(hasAnchorBleedBug(null)).toBe(false);
    expect(hasAnchorBleedBug(undefined)).toBe(false);
  });
});
