import * as vscode from "vscode";
import { AccountMeta } from "./accounts";

/** 节点判别式与 contextValue 常量：产出方与消费方共用，避免字面量在两处漂移。 */
export const NODE_SERIES = "series";
export const NODE_ROOT = "root";
export const CTX_ACCOUNT = "lkmAccount";
export const CTX_EMPTY = "lkmEmpty";
export const CTX_SERIES = "lkmSeries";
/** 无账号时根节点的展示文案。 */
export const EMPTY_ACCOUNT_LABEL = "（未添加账号）";

/** 系列树节点的数据结构。 */
export interface SeriesTreeNodeData {
  __lkm: typeof NODE_SERIES;
  key: string;
  repoName: string;
  dir: string;
  id?: number;
}

/** 虚拟根节点（承载账号展示名）。 */
export interface SeriesTreeRootData {
  __lkm: typeof NODE_ROOT;
}

/** 树里可能出现的节点集合。 */
export type SeriesTreeElement = SeriesTreeNodeData | SeriesTreeRootData;

/**
 * 账号根节点的展示名。
 * 供 buildRootItem / buildTreeChildren 复用。
 */
export function accountLabel(account: AccountMeta | null): string {
  return account ? `${account.username} @ ${account.serverUrl}` : EMPTY_ACCOUNT_LABEL;
}

/** 生成树 children：无账号→空；有账号→该账号所有系列的叶子节点。 */
export function buildTreeChildren(account: AccountMeta | null): SeriesTreeNodeData[] {
  if (!account) return [];
  return Object.entries(account.series).map(([repoName, entry]) => ({
    __lkm: NODE_SERIES,
    key: account.key,
    repoName,
    dir: entry.dir,
    id: entry.id,
  }));
}

/** 构造账号根 TreeItem。 */
export function buildRootItem(account: AccountMeta | null): vscode.TreeItem {
  const item = new vscode.TreeItem(accountLabel(account), vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = account ? CTX_ACCOUNT : CTX_EMPTY;
  return item;
}

/** 构造系列 TreeItem（按钮命令 contextValue 由 Task 8 挂）。 */
export function buildSeriesItem(node: SeriesTreeNodeData): vscode.TreeItem {
  const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.None);
  item.description = node.dir;
  item.contextValue = CTX_SERIES;
  item.id = `${node.key}#${node.repoName}`;
  return item;
}

/** TreeDataProvider：以当前账号为源，暴露 getChildren/getTreeItem，供 extension 注册。 */
export class SeriesTreeProvider implements vscode.TreeDataProvider<unknown>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
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
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element: unknown): vscode.TreeItem {
    const kind = (element as { __lkm?: string } | null)?.__lkm;
    if (kind === NODE_SERIES) return buildSeriesItem(element as SeriesTreeNodeData);
    if (kind === NODE_ROOT) return buildRootItem(this.account);
    // children 只可能是上述两种节点；出现其它值说明判别式失配，直接暴露而不是静默渲染成根节点。
    throw new Error(`未知的树节点类型：${String(kind)}`);
  }
  getChildren(element?: unknown): unknown[] {
    if (!element) {
      // 根层始终返回虚拟根：无账号时由它渲染「（未添加账号）」占位，
      // 返回 [] 会让占位分支彻底不可达，视图只剩空白。
      return [this.buildVirtualRoot()];
    }
    if ((element as { __lkm?: string }).__lkm === NODE_ROOT) {
      return buildTreeChildren(this.account);
    }
    return [];
  }
  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
  private buildVirtualRoot(): SeriesTreeRootData {
    return { __lkm: NODE_ROOT };
  }
}
