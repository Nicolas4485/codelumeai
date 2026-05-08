import { describe, it, expect } from "vitest";
import { hashContent, MemoryCache } from "./cache";

describe("hashContent", () => {
  it("produces a deterministic hash for the same content", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("produces different hashes for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("produces different hashes when salts differ", () => {
    expect(hashContent("hello", "salt-a")).not.toBe(
      hashContent("hello", "salt-b"),
    );
  });

  it("produces different hashes when salt order differs", () => {
    expect(hashContent("hello", "a", "b")).not.toBe(
      hashContent("hello", "b", "a"),
    );
  });

  it("returns a 64-character hex string", () => {
    const h = hashContent("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("MemoryCache", () => {
  it("returns undefined for unknown keys", () => {
    const c = new MemoryCache<string>();
    expect(c.get("missing")).toBeUndefined();
  });

  it("set then get returns the same value with a timestamp", () => {
    const c = new MemoryCache<string>();
    const before = Date.now();
    c.set("k", "v");
    const entry = c.get("k");
    expect(entry?.value).toBe("v");
    expect(entry?.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry?.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("set overwrites prior value", () => {
    const c = new MemoryCache<string>();
    c.set("k", "first");
    c.set("k", "second");
    expect(c.get("k")?.value).toBe("second");
  });

  it("delete removes the entry", () => {
    const c = new MemoryCache<string>();
    c.set("k", "v");
    c.delete("k");
    expect(c.get("k")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const c = new MemoryCache<number>();
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("size reports the number of stored entries", () => {
    const c = new MemoryCache<number>();
    expect(c.size()).toBe(0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.size()).toBe(2);
    c.delete("a");
    expect(c.size()).toBe(1);
  });
});
