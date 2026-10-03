import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { AccountMeta } from "../src/accounts";
import { startAutoSync } from "../src/extension";
import { __emitDidSave } from "./mocks/vscode";

const account: AccountMeta = {
  key: "https://h:alice",
  serverUrl: "https://h",
  username: "alice",
  series: { blog: { dir: "/work/blog", id: 1 } },
};

describe("保存后自动推送", () => {
  afterEach(async () => {
    await vscode.workspace.getConfiguration("lkm").update("autoPush.enabled", false, true);
    vi.restoreAllMocks();
  });

  it("只在映射仓库的文件保存后提交并推送", async () => {
    await vscode.workspace.getConfiguration("lkm").update("autoPush.enabled", true, true);
    const repo = {
      rootUri: { fsPath: "/work/blog" },
      pull: vi.fn(), push: vi.fn(), status: vi.fn(), add: vi.fn(), commit: vi.fn(),
      state: {
        indexChanges: [],
        workingTreeChanges: [{ uri: { fsPath: "/work/blog/post.md" } }],
      },
    };
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ getAPI: () => ({ repositories: [repo] }) }),
    } as never);
    const disposable = startAutoSync({} as never, () => account);
    try {
      __emitDidSave({ uri: { scheme: "file", fsPath: "/work/other/post.md" } });
      expect(repo.status).not.toHaveBeenCalled();
      __emitDidSave({ uri: { scheme: "file", fsPath: "/work/blog/post.md" } });
      await vi.waitFor(() => expect(repo.status).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(repo.push).toHaveBeenCalledOnce());
      expect(repo.add).toHaveBeenCalledWith(["/work/blog/post.md"]);
      expect(repo.commit).toHaveBeenCalledOnce();
    } finally {
      disposable.dispose();
    }
  });
});
