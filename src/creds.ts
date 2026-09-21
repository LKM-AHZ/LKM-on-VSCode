import * as vscode from "vscode";
import { accountKey } from "./accounts";

const CRED_KEY = "lkm.blog.credentials";
const SEP = "\u0000";

/** 按账号 SecretStorage key 的前缀。 */
const CRED_PREFIX = "lkm.blog.credentials.";

/** 按账号 key 生成 SecretStorage key；base64 把任意账号串编码成无空白/控制字符的稳定 key。 */
function credKeyFor(key: string): string {
  return CRED_PREFIX + Buffer.from(key).toString("base64");
}

/**
 * 解析 `username\0password`。
 * 只按第一个分隔符切分：密码里若含 NUL 也原样保留，不会被截断。
 */
function decodeCredential(raw: string | undefined): { username: string; password: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf(SEP);
  if (sep < 0) return null;
  const username = raw.slice(0, sep);
  const password = raw.slice(sep + SEP.length);
  // 用户名或密码任一为空都视为无效凭证（空密码不能被当作有效凭证绕过录入）。
  if (!username || !password) return null;
  return { username, password };
}

/** 编码 `username\0password`（NUL 不会出现在用户名/密码中）。 */
function encodeCredential(username: string, password: string): string {
  return username + SEP + password;
}

export async function getCredentials(
  context: vscode.ExtensionContext
): Promise<{ username: string; password: string } | null> {
  return decodeCredential(await context.secrets.get(CRED_KEY));
}

export async function saveCredentials(
  context: vscode.ExtensionContext,
  username: string,
  password: string
): Promise<void> {
  await context.secrets.store(CRED_KEY, encodeCredential(username, password));
}

export async function clearCredentials(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(CRED_KEY);
}

export async function promptForCredentials(
  context: vscode.ExtensionContext
): Promise<{ username: string; password: string }> {
  const username =
    (await vscode.window.showInputBox({
      prompt: "LKM 用户名",
      ignoreFocusOut: true,
    })) ?? "";
  const password =
    (await vscode.window.showInputBox({
      prompt: "LKM 密码",
      password: true,
      ignoreFocusOut: true,
    })) ?? "";
  // 用户名或密码任一为空（取消/留空）都不落 SecretStorage，避免把空密码持久化。
  if (username && password) {
    await saveCredentials(context, username, password);
  }
  return { username, password };
}

export function basicHeader(username: string, password: string): string {
  // RFC 7617：Basic user-id 不能含冒号，否则服务端解析出的用户名与本地记录不一致。
  if (username.includes(":")) {
    throw new Error("用户名不能包含冒号（Basic 认证不允许）");
  }
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

/** 按账号 key（accountKey 生成）读取凭证；无/残缺返回 null。 */
export async function getCredentialsForAccount(
  context: vscode.ExtensionContext,
  key: string
): Promise<{ username: string; password: string } | null> {
  return decodeCredential(await context.secrets.get(credKeyFor(key)));
}

/** 按账号 key 写凭证。 */
export async function saveCredentialsForAccount(
  context: vscode.ExtensionContext,
  key: string,
  username: string,
  password: string
): Promise<void> {
  await context.secrets.store(credKeyFor(key), encodeCredential(username, password));
}

/** 按账号 key 删除凭证。 */
export async function clearCredentialsForAccount(
  context: vscode.ExtensionContext,
  key: string
): Promise<void> {
  await context.secrets.delete(credKeyFor(key));
}

/**
 * 仅收集密码（用户名已在账号元数据里），存 SecretStorage 后返回完整凭证。
 * 用户取消/留空则返回 null（不落存）。
 */
export async function promptCredentialsForAccount(
  context: vscode.ExtensionContext,
  serverUrl: string,
  username: string
): Promise<{ username: string; password: string } | null> {
  const password =
    (await vscode.window.showInputBox({
      prompt: `「${username}」的 LKM 密码`,
      password: true,
      ignoreFocusOut: true,
    })) ?? "";
  if (!password) return null;
  const key = accountKey(serverUrl, username);
  try {
    await saveCredentialsForAccount(context, key, username, password);
  } catch (err) {
    // 写失败不能让用户以为密码已保存；返回 null 并显式报错。
    void vscode.window.showErrorMessage(
      `保存凭证失败：${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  return { username, password };
}
