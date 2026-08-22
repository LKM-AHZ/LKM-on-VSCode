import { describe, it, expect } from "vitest";
import { AccountMeta } from "../src/accounts";
import { shouldPullNow, pathBelongsToAccount, collectPullTargets } from "../src/sync";

const account: AccountMeta = {
  key: "k",
  serverUrl: "https://h",
  username: "alice",
  series: { "a-blog": { dir: "C:/x/a-blog" }, "b-lib": { dir: "C:/x/b-lib" } },
};

describe("sync 决策", () => {
  it("shouldPullNow 从未跑或超间隔返回 true", () => {
    expect(shouldPullNow(null, 5, 1000)).toBe(true);
    expect(shouldPullNow(0, 5, 300000)).toBe(true); // last=0, now-last ≥ 5min=300000ms
    expect(shouldPullNow(0, 5, 300)).toBe(false); // 差 300ms < 300000ms
  });

  it("pathBelongsToAccount 以目录前缀匹配", () => {
    expect(pathBelongsToAccount("C:/x/a-blog/file.md", account)).toBe("C:/x/a-blog");
    expect(pathBelongsToAccount("C:/x/a-blog", account)).toBe("C:/x/a-blog");
    expect(pathBelongsToAccount("C:/x/other", account)).toBeNull();
    expect(pathBelongsToAccount("C:/x/a-blog-extra", account)).toBeNull(); // 非目录边界
  });

  it("pathBelongsToAccount 最长匹配优先", () => {
    const nested: AccountMeta = { ...account, series: { a: { dir: "C:/x/a" }, "a/sub": { dir: "C:/x/a/sub" } } };
    // "a" 匹配到 "a/sub"（更长）应返回 "C:/x/a/sub"
    expect(pathBelongsToAccount("C:/x/a/sub/deep.md", nested)).toBe("C:/x/a/sub");
    expect(pathBelongsToAccount("C:/x/a/other.md", nested)).toBe("C:/x/a");
  });

  it("collectPullTargets 返回去重目录", () => {
    expect(collectPullTargets(account).sort()).toEqual(["C:/x/a-blog", "C:/x/b-lib"]);
  });
});
