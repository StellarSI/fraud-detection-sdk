/** Contract tests for the unified model plugin interface (issue #43). */

import { describe, expect, it } from "vitest";
import { isModelPlugin, type ModelContext, type ModelPlugin } from "./types.js";
import type { Signal } from "../types.js";

describe("ModelPlugin contract (issue #43)", () => {
  it("accepts an object implementing id, async score and configure", () => {
    const plugin: ModelPlugin = {
      id: "contract-stub",
      async score(_context: ModelContext): Promise<Signal[]> {
        return [{ id: "contract-stub", weight: 0.5 }];
      },
      configure(_options): void {
        // no options needed by the stub
      },
    };

    expect(isModelPlugin(plugin)).toBe(true);
  });

  it("rejects partial implementations", () => {
    expect(isModelPlugin(null)).toBe(false);
    expect(isModelPlugin({ id: "missing-methods" })).toBe(false);
    expect(isModelPlugin({ id: "", score: async () => [], configure: () => undefined })).toBe(false);
    expect(
      isModelPlugin({
        id: "sync-score",
        score: () => [],
        configure: () => undefined,
      }),
    ).toBe(true); // shape guard only; the interface itself requires Promise<Signal[]>
  });

  it("returns signals asynchronously", async () => {
    const plugin: ModelPlugin = {
      id: "async-stub",
      async score() {
        return [{ id: "async-stub", weight: 1 }];
      },
      configure: () => undefined,
    };
    const result = plugin.score({ transactions: [] });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([{ id: "async-stub", weight: 1 }]);
  });
});
