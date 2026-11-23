import { describe, expect, it } from "vitest";
import { InMemoryBaselineStore } from "./index.js";

describe("InMemoryBaselineStore", () => {
  it("supports basic CRUD operations", () => {
    const store = new InMemoryBaselineStore<number>();
    expect(store.get("a")).toBeUndefined();

    store.put("a", 1);
    expect(store.get("a")).toBe(1);

    store.put("a", 2);
    expect(store.get("a")).toBe(2);

    store.delete("a");
    expect(store.get("a")).toBeUndefined();
  });

  it("can be used as an injected dependency", async () => {
    const store = new InMemoryBaselineStore<{ value: string }>();
    const client = {
      save: (k: string, v: { value: string }) => store.put(k, v),
      load: (k: string) => store.get(k),
      remove: (k: string) => store.delete(k),
    };

    client.save("k", { value: "v" });
    expect(client.load("k")).toEqual({ value: "v" });
    client.remove("k");
    expect(client.load("k")).toBeUndefined();
  });
});
