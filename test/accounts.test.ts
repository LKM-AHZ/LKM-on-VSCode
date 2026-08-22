import { describe, it, expect } from "vitest";
import {
  accountKey,
  addAccount,
  removeAccount,
  mapSeries,
  unmapSeries,
  listAccounts,
  seriesDir,
  seriesId,
  normalizeSeriesMap,
  AccountMeta,
} from "../src/accounts";

const A: AccountMeta = { key: "https://h:alice", serverUrl: "https://h", username: "alice", series: {} };

describe("accounts", () => {
  it("accountKey 用 serverUrl:username", () => {
    expect(accountKey("https://h", "alice")).toBe("https://h:alice");
  });

  it("addAccount 追加并去重同 key", () => {
    const list = addAccount([], "https://h", "alice");
    expect(list).toHaveLength(1);
    const again = addAccount(list, "https://h", "alice"); // 同 key → 替换不新增
    expect(again).toHaveLength(1);
    const two = addAccount(list, "https://h", "bob");
    expect(two).toHaveLength(2);
  });

  it("listAccounts 返回全量且含 A 当 key 匹配", () => {
    const list = listAccounts([A]);
    expect(list).toHaveLength(1);
  });

  it("removeAccount 删除指定账号", () => {
    const bob = { ...A, key: "https://h:bob", username: "bob" };
    expect(removeAccount([A, bob], "https://h:bob")).toEqual([A]);
    expect(removeAccount([A, bob], "nope")).toHaveLength(2);
  });

  it("mapSeries 追加且不可变（值含 dir 与可选 id）", () => {
    const m = mapSeries(A, "my-blog", "C:/x/my-blog", 7);
    expect(A.series["my-blog"]).toBeUndefined(); // 原对象不变
    expect(m.series["my-blog"]).toEqual({ dir: "C:/x/my-blog", id: 7 });
    // 覆盖同名键
    const overwrite = mapSeries(m, "my-blog", "D:/new", 8);
    expect(Object.keys(overwrite.series)).toHaveLength(1);
    expect(overwrite.series["my-blog"]).toEqual({ dir: "D:/new", id: 8 });
    // 不传 id 时无 id 字段
    const noId = mapSeries(A, "x", "/x");
    expect(noId.series["x"]).toEqual({ dir: "/x" });
  });

  it("unmapSeries 删除映射", () => {
    const m = mapSeries(A, "my-blog", "C:/x/my-blog", 7);
    const u = unmapSeries(m, "my-blog");
    expect(u.series["my-blog"]).toBeUndefined();
    expect(unmapSeries(u, "absent").series).toEqual(u.series);
  });

  it("seriesDir 与 seriesId 便捷取数", () => {
    const m = mapSeries(A, "a", "/a", 3).series;
    expect(seriesDir(m, "a")).toBe("/a");
    expect(seriesId({ ...A, series: m }, "a")).toBe(3);
    expect(seriesId({ ...A, series: m }, "absent")).toBeUndefined();
    // 无 id 字段返回 undefined
    const m2 = mapSeries(A, "b", "/b").series;
    expect(seriesId({ ...A, series: m2 }, "b")).toBeUndefined();
  });

  it("normalizeSeriesMap 迁移旧裸 string 为 { dir }", () => {
    const old = { "my-blog": "C:/x/my-blog" };
    expect(normalizeSeriesMap(old)).toEqual({ "my-blog": { dir: "C:/x/my-blog" } });
  });

  it("normalizeSeriesMap 对象值保留不动", () => {
    const obj = { "my-blog": { dir: "C:/x/my-blog", id: 7 } };
    expect(normalizeSeriesMap(obj)).toEqual({ "my-blog": { dir: "C:/x/my-blog", id: 7 } });
  });

  it("normalizeSeriesMap 混合 string 与对象", () => {
    const mixed = { old: "D:/old", fresh: { dir: "E:/fresh", id: 3 }, noId: { dir: "F:/no" } };
    expect(normalizeSeriesMap(mixed)).toEqual({
      old: { dir: "D:/old" },
      fresh: { dir: "E:/fresh", id: 3 },
      noId: { dir: "F:/no" },
    });
  });
});
