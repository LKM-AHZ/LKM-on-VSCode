import * as vscode from "vscode";
import { AccountMeta } from "./accounts";

/** 系列树节点的数据结构。 */
export interface SeriesTreeNodeData {
  __lkm: "series";
  key: string;
  repoName: string;
  dir: string;
  id?: number;
}

/**
 * 账号根节点的展示名。
 * 供 buildRootItem / buildTreeChildren 复用。
 */
export function accountLabel(account: AccountMeta | null): string {
  return account ? `${account.username} @ ${account.serverUrl}` : "（未添加账号）";
}

/** 生成树 children：无账号→空；有账号→该账号所有系列的叶子节点。 */
export function buildTreeChildren(account: AccountMeta | null): SeriesTreeNodeData[] {
  if (!account) return [];
  return Object.entries(account.series).map(([repoName, entry]) => ({
    __lkm: "series",
    key: account.key,
    repoName,
    dir: entry.dir,
    id: entry.id,
  }));
}

/** 构造账号根 TreeItem。 */
export function buildRootItem(account: AccountMeta | null): vscode.TreeItem {
  const item = new vscode.TreeItem(accountLabel(account), vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = account ? "lkmAccount" : "lkmEmpty";
  return item;
}

/** 构造系列 TreeItem（按钮命令 contextValue 由 Task 8 挂）。 */
export function buildSeriesItem(node: SeriesTreeNodeData): vscode.TreeItem {
  const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.None);
  item.description = node.dir;
  item.contextValue = "lkmSeries";
  item.id = `${node.key}#${node.repoName}`;
  return item;
}

/** TreeDataProvider：以当前账号为源，暴露 getChildren/getTreeItem，供 extension 注册。 */
export class SeriesTreeProvider implements vscode.TreeDataProvider<unknown> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private account: AccountMeta | null;
  constructor(account: AccountMeta | null) {
    this.account = account;
  }
  setAccount(a: AccountMeta | null): void {
    this.account = a;
    this.refresh();
  }
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
  getTreeItem(element: unknown): vscode.TreeItem {
    if (element && (element as SeriesTreeNodeData).__lkm === "series") {
      return buildSeriesItem(element as SeriesTreeNodeData);
    }
    return buildRootItem(this.account);
  }
  getChildren(element?: unknown): unknown[] {
    if (!element) {
      // 根层：若为 null 用空提示，否则返回一个虚拟根（实际由 provider 直接渲染 single item）
      return this.account ? [this.buildVirtualRoot()] : [];
    }
    if ((element as { __lkm?: string }).__lkm === "root") {
      return buildTreeChildren(this.account);
    }
    return [];
  }
  private buildVirtualRoot(): unknown {
    return { __lkm: "root" };
  }
}
