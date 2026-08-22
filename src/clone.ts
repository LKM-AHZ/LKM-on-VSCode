import * as vscode from "vscode";
import { getCredentials, getCredentialsForAccount, promptForCredentials, promptCredentialsForAccount, basicHeader } from "./creds";
import { listSeries, BlogSeries, gitCloneUrl } from "./api";
import { embedBasicAuth } from "./git";
import { AccountMeta, mapSeries } from "./accounts";

/**
 * 从配置读取 lkm.serverUrl：trim + 去尾斜杠。
 * 未配置（空字符串）时抛错提示用户先设置。
 *
 * @param getConfig 按 key 取配置值的函数（由注入方提供，便于测试）
 * @returns 去尾斜杠后的后端地址（如 "https://h/" → "https://h"）
 */
export function serverUrlFromConfig(getConfig: (k: string) => string | undefined): string {
  const raw = (getConfig("lkm.serverUrl") ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("未配置 lkm.serverUrl，请先设置 LKM 后端地址");
  return raw;
}

/** clone 流程的最终结果。 */
export type CloneOutcome =
  | { kind: "cloned"; message: string }
  | { kind: "cancelled"; message?: string }
  | { kind: "error"; message: string };

/**
 * clone 流程所需的 UI 注入点。把用户交互与外部副作用抽成接口，
 * 使 runCloneFlow 可以在单测中 mock，业务层绑定真实实现。
 */
export interface CloneDeps {
  /** 按 key 读配置（如 lkm.serverUrl）。 */
  getConfig(key: string): string | undefined;
  /** 让用户从系列列表中 QuickPick 一个，取消返回 null。 */
  pickSeries(series: BlogSeries[]): Promise<BlogSeries | null>;
  /** 让用户选择一个目标目录，取消/未选返回 undefined。 */
  pickTargetDir(): Promise<string | undefined>;
  /** 实际执行 git clone，失败抛错。 */
  doClone(url: string, dir: string): Promise<void>;
  /** clone 成功后的可选提示（如提醒移除 remote 明文）。 */
  afterCloneHint?: (dir: string) => Promise<void>;
}

/**
 * 编排 clone 流程：取凭证 → 列系列 → 选系列 → 选目录 → clone。
 *
 * 流程各分支：
 * - 无已保存凭证则弹窗录入；输入空则 cancelled。
 * - listSeries 异常 → error。
 * - 空系列列表 → error。
 * - 用户取消选系列 → cancelled。
 * - 用户取消选目录 → cancelled。
 * - clone 异常 → error；成功 → cloned。
 *
 * @param context VS Code 扩展上下文（用于 secret 读取）
 * @param deps UI 注入点
 */
export async function runCloneFlow(
  context: vscode.ExtensionContext,
  deps: CloneDeps
): Promise<CloneOutcome> {
  // 先读已保存凭证，没有则弹窗录入。
  let creds = await getCredentials(context);
  if (!creds) {
    creds = await promptForCredentials(context);
    if (!creds.username || !creds.password) {
      return { kind: "cancelled", message: "未提供凭证" };
    }
  }

  const serverUrl = serverUrlFromConfig(deps.getConfig);
  const auth = basicHeader(creds.username, creds.password);

  let seriesList: BlogSeries[];
  try {
    seriesList = await listSeries(serverUrl, auth);
  } catch (err) {
    return { kind: "error", message: `列系列失败：${(err as Error).message}` };
  }
  if (seriesList.length === 0) {
    return { kind: "error", message: "没有可访问的 blog 系列" };
  }

  const picked = await deps.pickSeries(seriesList);
  if (!picked) return { kind: "cancelled", message: "未选择系列" };

  const targetDir = await deps.pickTargetDir();
  if (!targetDir) return { kind: "cancelled", message: "未选择目标目录" };

  const bareUrl = gitCloneUrl(serverUrl, creds.username, creds.password, picked.repo_name);
  const cloneUrl = embedBasicAuth(bareUrl, creds.username, creds.password);

  try {
    await deps.doClone(cloneUrl, targetDir);
    return { kind: "cloned", message: `已克隆 ${picked.title}` };
  } catch (err) {
    return { kind: "error", message: `克隆失败：${(err as Error).message}` };
  }
}

/** 按账号 clone 的最终结果：cloned 分支含已写回映射的新账号。 */
export type CloneResult =
  | {
      kind: "cloned";
      account: AccountMeta;
      series: { repo_name: string; dir: string; id: number };
      message: string;
    }
  | { kind: "cancelled"; message?: string }
  | { kind: "error"; message: string };

/**
 * 对指定账号执行 clone：取按账号凭证→列系列→选系列→选目录→clone→返回结果。
 * 成功时用 mapSeries 把新系列写回账号映射（由调用方把返回的 account 更新到账号列表）。
 *
 * 各分支：
 * - 无按账号凭证则弹窗录入密码；取消 → cancelled。
 * - 配置缺失 → error。
 * - listSeries 异常 → error。
 * - 空系列列表 → error。
 * - 取消选系列/选目录 → cancelled。
 * - clone 异常 → error；成功 → cloned（并触发 afterCloneHint 提示）。
 *
 * @param context VS Code 扩展上下文（用于按账号 secret 读取）
 * @param account 目标账号（key 决定凭证读取，series 会被写回新映射）
 * @param deps UI 注入点
 */
export async function runCloneForAccount(
  context: vscode.ExtensionContext,
  account: AccountMeta,
  deps: CloneDeps
): Promise<CloneResult> {
  // 用账号 key 读该账号的凭证，没有则弹窗只录密码。
  let creds = await getCredentialsForAccount(context, account.key);
  if (!creds) {
    const prompted = await promptCredentialsForAccount(context, account.serverUrl, account.username);
    if (!prompted) return { kind: "cancelled", message: "未提供凭证" };
    creds = prompted;
  }

  // 账号自带 serverUrl 为事实源，避免把某账号凭证发给配置里的全局地址同时泄漏到错误主机。
  const serverUrl = account.serverUrl.replace(/\/+$/, "");
  const auth = basicHeader(creds.username, creds.password);

  let seriesList;
  try {
    seriesList = await listSeries(serverUrl, auth);
  } catch (err) {
    return { kind: "error", message: `列系列失败：${(err as Error).message}` };
  }
  if (seriesList.length === 0) {
    return { kind: "error", message: "没有可访问的 blog 系列" };
  }
  const picked = await deps.pickSeries(seriesList);
  if (!picked) return { kind: "cancelled", message: "未选择系列" };

  const targetDir = await deps.pickTargetDir();
  if (!targetDir) return { kind: "cancelled", message: "未选择目标目录" };

  const bareUrl = gitCloneUrl(serverUrl, creds.username, creds.password, picked.repo_name);
  const cloneUrl = embedBasicAuth(bareUrl, creds.username, creds.password);
  try {
    await deps.doClone(cloneUrl, targetDir);
    await deps.afterCloneHint?.(targetDir);
    const updated = mapSeries(account, picked.repo_name, targetDir, picked.id);
    return {
      kind: "cloned",
      account: updated,
      series: { repo_name: picked.repo_name, dir: targetDir, id: picked.id },
      message: `已克隆 ${picked.title}`,
    };
  } catch (err) {
    return { kind: "error", message: `克隆失败：${(err as Error).message}` };
  }
}
