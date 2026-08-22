import { describe, it, expect } from "vitest";
import { AccountMeta } from "../src/accounts";
import { buildTreeChildren, buildRootItem, SeriesTreeNodeData } from "../src/tree";

const account: AccountMeta = {
  key: "https://h:alice",
  serverUrl: "https://h",
  username: "alice",
  series: { "a-blog": { dir: "C:/x/a-blog", id: 3 } },
};

describe("tree", () => {
  it("无账号时根展示空提示", () => {
    const children = buildTreeChildren(null);
    expect(children).toHaveLength(0);
  });

  it("有账号时 children 为系列节点（含 id）", () => {
    const children = buildTreeChildren(account);
    expect(children).toHaveLength(1);
    const n = children[0] as SeriesTreeNodeData;
    expect(n.repoName).toBe("a-blog");
    expect(n.dir).toBe("C:/x/a-blog");
    expect(n.key).toBe(account.key);
    expect(n.id).toBe(3);
  });

  it("buildRootItem 用账号显示名", () => {
    const item = buildRootItem(account);
    expect(item.label).toContain("alice");
  });
});
