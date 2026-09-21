/**
 * git 操作层：clone 系列仓库与 pull/push。
 *
 * 依赖 VS Code 内置 GitExtension（vscode.extensions.getExtension("vscode.git")）。
 * GitExtension 的运行时 API 类型不被 @types/vscode 覆盖，故通过 `any`/结构桥接
 * （VS Code 扩展常见做法）。纯函数 embedBasicAuth 单独抽出便于单测。
 */

import * as vscode from "vscode";

/**
 * 把 user:pass 以 Basic 认证的方式内联进裸 clone URL。
 *
 * 在 `://` 之后、host 之前插入 `encodeURIComponent(user):encodeURIComponent(pass)@`，
 * 返回内联凭证后的完整 URL。
 *
 * @param cloneUrl 裸仓库 URL（由 API 端生成，不含凭证）
 * @param username 用户名（会被 URL 编码）
 * @param password 密码（会被 URL 编码）
 */
export function embedBasicAuth(cloneUrl: string, username: string, password: string): string {
  const sep = cloneUrl.indexOf("://");
  // scp 风格（git@host:group/repo.git）没有 scheme，按 host 起始拼接会得到非法 URL 且静默失败。
  if (sep === -1) throw new Error(`无法内联凭证：仓库 URL 缺少 scheme（${cloneUrl}）`);
  const hostStart = sep + 3;
  const slash = cloneUrl.indexOf("/", hostStart);
  const authority = slash === -1 ? cloneUrl.slice(hostStart) : cloneUrl.slice(hostStart, slash);
  // 已含 userinfo 时再次内联会拼出 user:pass@user@host 这种非法 URL。
  if (authority.includes("@")) throw new Error("仓库 URL 已包含用户信息，拒绝重复内联凭证");
  const cred = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  return cloneUrl.slice(0, hostStart) + cred + cloneUrl.slice(hostStart);
}

/** 桥接出来的 GitExtension 子集：clone(url, parentPath) 返回克隆后的仓库路径。 */
interface GitApi {
  clone(url: string, parentPath: string): Promise<string>;
}

/**
 * 激活 vscode.git 扩展并返回其 API 对象。
 * 扩展不存在或激活失败返回 null，由调用方决定是抛错还是一并当作「无仓库」处理。
 */
async function activateGitApi(): Promise<unknown | null> {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return null;
  try {
    return ((await ext.activate()) as unknown) ?? null;
  } catch {
    return null;
  }
}

/**
 * 取 GitExtension 的桥接 API，负责激活扩展。
 *
 * getExtension 不存在或扩展未加载时抛错——clone 流程依赖它，必须失败快。
 */
async function gitApi(): Promise<GitApi> {
  const api = await activateGitApi();
  if (!api) throw new Error("vscode.git 扩展未加载或激活失败");
  if (typeof (api as GitApi).clone !== "function") throw new Error("vscode.git API 缺少 clone 方法");
  return api as GitApi;
}

/**
 * 克隆仓库到目标目录。
 *
 * @param cloneUrl 含内联凭证的 clone URL（由 embedBasicAuth 生成）
 * @param targetDir 父目录，GitExtension.clone 在其下创建仓库
 */
export async function cloneRepository(cloneUrl: string, targetDir: string): Promise<void> {
  const api = await gitApi();
  // GitExtension.clone(url, parentPath) 返回克隆后的仓库(字符串 path)
  await api.clone(cloneUrl, targetDir);
}

/** pull/push 操作的最小仓库接口。 */
export interface GitRepositoryHandle {
  pull(): Promise<void>;
  push(): Promise<void>;
}

/** 把仓库对象包装成 {pull, push} 的 GitRepositoryHandle。 */
function wrapRepository(repo: unknown): GitRepositoryHandle {
  // vscode.git 的 API 对象没有类型保障，缺方法时在此明确报错，
  // 否则会拖到调用点变成 "Cannot read properties of undefined" 这类难定位的错误。
  const typed = repo as { pull?: unknown; push?: unknown };
  if (typeof typed.pull !== "function" || typeof typed.push !== "function") {
    throw new Error("vscode.git 仓库对象缺少 pull/push 方法");
  }
  return {
    pull: () => (typed.pull as () => Promise<void>)(),
    push: () => (typed.push as () => Promise<void>)(),
  };
}

/**
 * 取当前活动工作区的仓库，包装成 {pull, push}。
 *
 * - 无 Git 扩展 / 无仓库：返回 null。
 * - 单仓库：直接包装，不弹选择器。
 * - 多仓库：走 QuickPick 让用户选择。
 */
export async function getActiveGitRepository(): Promise<GitRepositoryHandle | null> {
  const api = await activateGitApi();
  if (!api) return null;
  const repos = (api as { repositories?: unknown[] }).repositories ?? [];
  if (repos.length === 0) return null;
  // 恰好一个仓库时直接包装，避免无谓弹出的单项选择器。
  if (repos.length === 1) return wrapRepository(repos[0]);
  // 多个仓库：走 QuickPick 让用户选择。
  return pickRepository(api);
}

/**
 * 让用户从所有 Git 仓库中 QuickPick 一个，返回其 {pull, push} 包装。
 * 用户取消时返回 null。调用方保证仓库集合非空。
 */
async function pickRepository(api: unknown): Promise<GitRepositoryHandle | null> {
  const repos = (api as { repositories?: unknown[] }).repositories ?? [];
  // rootUri 缺失时给个可辨识的占位，避免 QuickPick 出现无法区分的空标题条目。
  const label = (r: unknown) => (r as { rootUri?: { fsPath?: string } }).rootUri?.fsPath ?? "（未知路径）";
  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: label(r), repo: r })),
    { placeHolder: "选择要同步的仓库" }
  );
  if (!picked) return null;
  return wrapRepository(picked.repo);
}

/** 文件系统是否大小写不敏感（Windows/macOS 默认如此）。 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** 路径归一化为正斜杠，便于跨平台比较（Windows 反斜杠 vs 正斜杠）。 */
function normFs(p: string): string {
  const s = p.replace(/\\/g, "/");
  // Linux 等大小写敏感的文件系统上不能统一转小写，否则 /a/Repo 与 /a/repo 会被当成同一仓库。
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s;
}

/** 按目录解析 GitExtension 仓库对象，包装成 {pull, push}。 */
export async function getGitByDir(dir: string): Promise<GitRepositoryHandle | null> {
  try {
    const api = await activateGitApi();
    if (!api) return null;
    const repos = (api as { repositories?: unknown[] }).repositories ?? [];
    const target = normFs(dir);
    for (const r of repos) {
      const root = (r as { rootUri?: { fsPath?: string } }).rootUri?.fsPath;
      if (root && normFs(root) === target) return wrapRepository(r);
    }
    return null;
  } catch (err) {
    // 「该目录没有仓库」是预期情况（返回 null），但扩展激活/API 异常不是：
    // 打日志把两者区分开，否则自动同步静默失效无从排查。
    console.warn("[lkm] 解析 git 仓库失败：", err);
    return null;
  }
}
