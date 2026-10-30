import * as vscode from "vscode";
import { AccountMeta } from "./accounts";
import { getGitByDir } from "./git";
import { SyncSettings, shouldPullNow, pathBelongsToAccount, collectPullTargets } from "./sync";

/**
 * 启动自动同步副作用：定时轮询 pull + 聚焦 pull + 保存 auto-push 决策。
 *
 * - 定时器周期在启动时按配置算一次；每次 tick 再按最新配置决定是否 pull。
 * - pull 只读，失败静默（badge 由 tree provider 展示）。
 * - auto-push 默认关（lkm.autoPush.enabled）；开启时仅提交本次保存的文件再推送。
 * 返回 Disposable，在 activate 的 subscriptions 中注入以便停用时清理。
 */
export function startAutoSync(
  getCurrentAccount: () => AccountMeta | null
): vscode.Disposable {
  const settings = (): SyncSettings => {
    const config = vscode.workspace.getConfiguration("lkm");
    return {
      pullIntervalMinutes: config.get("sync.pullIntervalMinutes", 5),
      pullOnFocus: config.get("sync.pullOnFocus", true),
      autoPushEnabled: config.get("autoPush.enabled", false),
    };
  };
  const lastRunByDir = new Map<string, number>();
  const pendingByDir = new Map<string, Promise<void>>();

  // 同一个仓库的 pull/commit/push 串行执行，避免保存事件与定时拉取相互抢占。
  function enqueue(dir: string, operation: () => Promise<void>): Promise<void> {
    const previous = pendingByDir.get(dir) ?? Promise.resolve();
    const task = previous.then(operation);
    const settled = task.catch(() => {});
    pendingByDir.set(dir, settled);
    void settled.then(() => {
      if (pendingByDir.get(dir) === settled) pendingByDir.delete(dir);
    });
    return task;
  }

  async function pullOne(dir: string): Promise<void> {
    try {
      await enqueue(dir, async () => {
        const git = await getGitByDir(dir);
        if (!git) return;
        await git.pull();
        lastRunByDir.set(dir, Date.now());
      });
    } catch {
      /* 静默，badge 由 provider 展示 */
    }
  }
  async function pullAll(): Promise<void> {
    const acc = getCurrentAccount();
    if (!acc) return;
    const cfg = settings();
    for (const dir of collectPullTargets(acc)) {
      if (shouldPullNow(lastRunByDir.get(dir) ?? null, cfg.pullIntervalMinutes, Date.now())) {
        await pullOne(dir);
      }
    }
  }

  const timer = setInterval(
    () => {
      void pullAll();
    },
    Math.max(settings().pullIntervalMinutes, 1) * 60 * 1000
  );

  const onFocus = vscode.window.onDidChangeWindowState((e) => {
    if (e.focused && settings().pullOnFocus) void pullAll();
  });

  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    const cfg = settings();
    if (!cfg.autoPushEnabled) return;
    const acc = getCurrentAccount();
    if (!acc || doc.uri.scheme !== "file") return;
    const filePath = doc.uri.fsPath;
    const dir = pathBelongsToAccount(filePath, acc);
    if (!dir) return;
    void enqueue(dir, async () => {
      const git = await getGitByDir(dir);
      if (!git) throw new Error(`未找到已打开的 Git 仓库：${dir}`);
      if (await git.commitSavedFile(filePath)) await git.push();
    })
      .catch((err) => {
        // 不能让它变成未处理的 Promise 拒绝：用户否则完全看不到自动同步失败。
        void vscode.window.showErrorMessage(
          `自动同步失败：${err instanceof Error ? err.message : String(err)}`
        );
      });
  });

  return new vscode.Disposable(() => {
    clearInterval(timer);
    onFocus.dispose();
    onSave.dispose();
  });
}

