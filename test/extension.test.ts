import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate } from "../src/extension";
import { __emitWindowState, createMementoStub } from "./mocks/vscode";

describe("扩展激活与资源释放", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("注册命令和视图，按最新账号同步，停用后移除监听与计时器", async () => {
    vi.useFakeTimers();
    const globalState = createMementoStub();
    // 保留旧版字符串映射，验证自动同步也经过账号数据归一化。
    await globalState.update("lkm.accounts", [
      { key: "alice", serverUrl: "https://h", username: "alice", series: { blog: "/work/alice" } },
      { key: "bob", serverUrl: "https://h", username: "bob", series: { blog: "/work/bob" } },
    ]);
    await globalState.update("lkm.currentAccount", "alice");
    const alice = { rootUri: { fsPath: "/work/alice" }, pull: vi.fn(async () => {}), push: vi.fn() };
    const bob = { rootUri: { fsPath: "/work/bob" }, pull: vi.fn(async () => {}), push: vi.fn() };
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ getAPI: () => ({ repositories: [alice, bob] }) }),
    } as never);
    const registerCommand = vi.spyOn(vscode.commands, "registerCommand");
    const registerTree = vi.spyOn(vscode.window, "registerTreeDataProvider");
    const subscriptions: vscode.Disposable[] = [];

    activate({ subscriptions, globalState } as unknown as vscode.ExtensionContext);
    const provider = registerTree.mock.calls[0][1] as vscode.Disposable;
    const disposeProvider = vi.spyOn(provider, "dispose");
    try {
      expect(registerCommand).toHaveBeenCalledTimes(9);
      expect(registerTree.mock.calls[0][0]).toBe("lkm.seriesTree");
      expect(vi.getTimerCount()).toBe(1);

      __emitWindowState({ focused: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(alice.pull).toHaveBeenCalledOnce();
      expect(bob.pull).not.toHaveBeenCalled();

      await globalState.update("lkm.currentAccount", "bob");
      __emitWindowState({ focused: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(bob.pull).toHaveBeenCalledOnce();
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }

    expect(disposeProvider).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await globalState.update("lkm.currentAccount", "alice");
    __emitWindowState({ focused: true });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(alice.pull).toHaveBeenCalledOnce();
    expect(bob.pull).toHaveBeenCalledOnce();
  });
});
