import * as vscode from "vscode";
import {
  AccountMeta,
  addAccount,
  removeAccount,
  findAccount,
  accountKey,
  mapSeries,
  unmapSeries,
  normalizeSeriesMap,
} from "./accounts";
import {
  getCredentialsForAccount,
  clearCredentialsForAccount,
  promptCredentialsForAccount,
} from "./creds";
import { listSeries, createSeries, deleteSeries, toggleStar, BlogSeries } from "./api";
import { createTokenManager, TokenManager } from "./auth";
import { CloneDeps, runCloneForAccount } from "./clone";
import { getActiveGitRepository, getGitByDir } from "./git";
import { SeriesTreeProvider } from "./tree";
import { SyncSettings, shouldPullNow, pathBelongsToAccount, collectPullTargets } from "./sync";

/** 克隆博客系列命令 id。 */
export const CLONE_CMD = "lkm.cloneBlog";
/** 拉取当前仓库命令 id。 */
export const PULL_CMD = "lkm.pull";
/** 推送当前仓库命令 id。 */
export const PUSH_CMD = "lkm.push";
/** 新增账号命令 id。 */
export const ADD_ACCOUNT_CMD = "lkm.addAccount";
/** 切换账号命令 id。 */
export const SWITCH_ACCOUNT_CMD = "lkm.switchAccount";
/** 删除账号命令 id。 */
export const REMOVE_ACCOUNT_CMD = "lkm.removeAccount";
/** 创建系列命令 id。 */
export const CREATE_SERIES_CMD = "lkm.createSeries";
/** 删除系列命令 id。 */
export const DELETE_SERIES_CMD = "lkm.deleteSeries";
/** 星标系列命令 id。 */
export const TOGGLE_STAR_CMD = "lkm.toggleStar";
/** 系列树视图 id（registerTreeDataProvider 用）。 */
export const MANAGE_SERIES_VIEW = "lkm.seriesTree";

/** vscode.commands.registerCommand 的类型，便于测试注入真假实现。 */
type RegisterFn = typeof vscode.commands.registerCommand;

/**
 * 读 LKM 配置段的值。键形如 "lkm.serverUrl"，
 * 剥掉 "lkm." 前缀后落到配置段的同名键。
 */
function getConfig<T>(key: string, dflt: T): T {
  const section = "lkm";
  const inner = key.slice(section.length + 1);
  return vscode.workspace.getConfiguration(section).get<T>(inner, dflt);
}

/** 从 globalState 读出账号列表，并对旧结构系列值（裸 string）做迁移规范化。 */
function loadAccounts(context: vscode.ExtensionContext): AccountMeta[] {
  const saved = (context.globalState.get("lkm.accounts") as AccountMeta[] | undefined) ?? [];
  return saved.map((a) => ({ ...a, series: normalizeSeriesMap(a.series ?? {}) }));
}

/** 把账号列表持久化到 globalState。 */
function saveAccounts(context: vscode.ExtensionContext, accounts: AccountMeta[]): void {
  void context.globalState.update("lkm.accounts", accounts);
}

/**
 * 注册全部 LKM 命令（v0.1 三命令 + 本版新增账号/系列命令），
 * 并返回 SeriesTreeProvider 供 activate 注册到树视图。
 *
 * 命令处理器共享闭包内的账号状态：accounts（列表）、currentKey/current（当前账号）。
 * register 注入以便测试；_ 为预留参数。
 *
 * @param context VS Code 扩展上下文（挂 subscriptions / 读写 globalState）
 * @param register 命令注册函数（测试可注入 spy）
 * @param _ 预留参数（当前未使用）
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  register: RegisterFn,
  _: never[]
): SeriesTreeProvider {
  // 账号状态（本实现里命令处理器共享闭包状态）。
  let accounts = loadAccounts(context);
  let currentKey = (context.globalState.get("lkm.currentAccount") as string | null) ?? null;
  let current = currentKey ? findAccount(accounts, currentKey) ?? null : null;

  // 按账号 key 缓存的 TokenManager：复用 token 规避登录限流（spec §4）。
  // 账号被移除时清掉对应条目，避免残留。
  const tokenManagers = new Map<string, TokenManager>();

  const provider = new SeriesTreeProvider(current);
  // 树 provider 由 activate 注册，此处不重复做。

  function setCurrent(account: AccountMeta | null): void {
    current = account;
    provider.setAccount(account);
  }

  /** 确保有当前账号，否则让用户先选择；返回当前账号或 null。 */
  async function ensureCurrent(): Promise<AccountMeta | null> {
    if (current) return current;
    await _pickAccount();
    return current;
  }

  async function _pickAccount(): Promise<void> {
    if (accounts.length === 0) {
      vscode.window.showWarningMessage("请先 LKM: Add Account 添加账号");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: a.username, description: a.serverUrl, key: a.key })),
      { placeHolder: "选择账号" }
    );
    if (picked) {
      currentKey = picked.key;
      const found = findAccount(accounts, picked.key) ?? null;
      setCurrent(found);
      void context.globalState.update("lkm.currentAccount", currentKey);
    }
  }

  /**
   * 判断一个错误是否为「认证失败（401）」的可靠信号。
   *
   * api.ts / auth.ts 对 HTTP 状态码抛 `HTTP ${res.status}`（401）或业务 msg；
   * 故匹配解析出的状态码（若可用）与字符串 "401"/"Unauthorized"。宽松的中文业务
   * 文案不作为判据，避免网络/业务错误被误判为认证失败而过度刷 token / 清凭证。
   * 非 Error 拒绝（如字符串）先归一，避免 .includes 在 undefined 上抛错。
   */
  function isAuthError(err: unknown): boolean {
    const status =
      err instanceof Error && "status" in err ? (err as { status: unknown }).status : undefined;
    if (typeof status === "number") return status === 401;
    const msg = err instanceof Error ? err.message : String(err);
    // "401" 必须单独成词：URL/repo 名里的 1401 之类不应被当成认证失败而触发清凭证+重登。
    return /(^|\D)401(\D|$)/.test(msg) || /\bUnauthorized\b/.test(msg);
  }

  /** 401 时令该账号缓存 token 失效（spec §4），使下一次操作重新兑换。 */
  function onAuthError(accountKey: string, err: unknown): void {
    if (isAuthError(err)) {
      tokenManagers.get(accountKey)?.invalidate();
    }
  }

  /**
   * 取当前账号可用的 Bearer token，并在认证失败时升级为「清凭证 + 重新引导输入」。
   *
   * spec §4/§10 要求：一次 401 只在缓存层自动重兑一次；若重兑（重新登录）仍被拒，
   * 不能持续向限流的 /auth/login/password 硬撞。因此这里在 token 层做收敛：
   *   1) 先用现有凭证取 token（内部会做一次 15 分钟过期重兑）；
   *   2) 取不到（无凭证）或抛出认证失败 → 清除该账号旧凭证，提示用户重新录入；
   *   3) 用户取消则返回 null；否则用新凭证重建 TokenManager 重试一次；
   *   4) 重试仍失败（如新凭证也被拒）→ 返回 null，不再继续。
   * 非认证失败（网络等）不判断为需要清凭证，直接返回 null 交由调用方提示。
   */
  async function ensureAuthedToken(account: AccountMeta): Promise<string | null> {
    let mgr = tokenManagers.get(account.key);
    if (!mgr) {
      mgr = createTokenManager({
        serverUrl: account.serverUrl,
        getCredentials: () => getCredentialsForAccount(context, account.key),
      });
      tokenManagers.set(account.key, mgr);
    }

    // 首次尝试：用现有（可能缓存可能过期的）凭证取 token。
    let authFailed = false;
    try {
      const tok = await mgr.getToken();
      if (tok) return tok;
      authFailed = true; // 无凭证可换 → 需要补录
    } catch (err) {
      onAuthError(account.key, err);
      if (!isAuthError(err)) return null; // 网络等非认证失败，不升级处理。
      authFailed = true;
    }
    if (!authFailed) return null;

    // 认证失败或凭证缺失：引导重新录入。提示放在录入之前，否则用户输完密码才看到「已失效」。
    // 不再预防性清除旧凭证：promptCredentialsForAccount 成功时会覆写 SecretStorage，
    // 而用户取消时必须保留原凭证，避免一次误判把有效凭证永久清掉。
    void vscode.window.showInformationMessage("登录凭证已失效，请重新输入密码");
    const creds = await promptCredentialsForAccount(context, account.serverUrl, account.username);
    if (!creds) return null; // 用户取消：保留原凭证。

    // 用新凭证重建 TokenManager 并重试一次；仍失败则放弃。
    tokenManagers.delete(account.key);
    mgr = createTokenManager({
      serverUrl: account.serverUrl,
      getCredentials: () => Promise.resolve(creds),
    });
    tokenManagers.set(account.key, mgr);
    try {
      return await mgr.getToken();
    } catch {
      return null;
    }
  }

  /** 把账号写回账号列表并持久化；若是当前账号，同步更新 current 并刷新树。 */
  function persistAccount(acc: AccountMeta): void {
    const idx = accounts.findIndex((a) => a.key === acc.key);
    accounts = idx >= 0 ? accounts.map((a) => (a.key === acc.key ? acc : a)) : [...accounts, acc];
    saveAccounts(context, accounts);
    if (current && current.key === acc.key) setCurrent(acc);
  }

  /**
   * 取某系列的后端 id：映射里已有（新结构）直接用；
   * 缺失（旧映射）则调 listSeries 按 repo_name 反查，成功后回写映射并持久化。
   * 返回 { id, account }（account 为回写后的账号）；反查不到/失败返回 null。
   */
  async function ensureSeriesId(
    acc: AccountMeta,
    repoName: string
  ): Promise<{ id: number; account: AccountMeta } | null> {
    const existing = acc.series[repoName]?.id;
    if (existing !== undefined) return { id: existing, account: acc };
    const tok = await ensureAuthedToken(acc);
    if (!tok) return null;
    let list: BlogSeries[];
    try {
      list = await listSeries(acc.serverUrl, `Bearer ${tok}`);
    } catch {
      return null;
    }
    const hit = list.find((s) => s.repo_name === repoName);
    if (!hit) return null;
    const updated = mapSeries(acc, repoName, acc.series[repoName]?.dir ?? "", hit.id);
    persistAccount(updated);
    return { id: hit.id, account: updated };
  }

  /**
   * 让用户从当前账号已映射的系列里选一个并解析其后端 id。
   * 无映射/用户取消/解析失败都返回 null（已给出对应提示），供删除、星标等命令复用。
   */
  async function pickMappedSeries(
    acc: AccountMeta,
    placeHolder: string
  ): Promise<{ repo: string; resolved: { id: number; account: AccountMeta } } | null> {
    const entries = Object.entries(acc.series);
    if (entries.length === 0) {
      vscode.window.showWarningMessage("当前账号没有已映射系列");
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map(([repo]) => ({ label: repo, repo })),
      { placeHolder }
    );
    if (!picked) return null;
    const resolved = await ensureSeriesId(acc, picked.repo);
    if (!resolved) {
      vscode.window.showErrorMessage(`无法确定系列 ${picked.repo} 的 id，可能已被删除`);
      return null;
    }
    return { repo: picked.repo, resolved };
  }

  // ---- LKM: Add Account ----
  async function handleAddAccount() {
    const serverUrl = (
      await vscode.window.showInputBox({ prompt: "LKM 后端地址", value: getConfig("serverUrl", ""), ignoreFocusOut: true })
    )?.trim();
    if (!serverUrl) return;
    const username = (
      await vscode.window.showInputBox({ prompt: "LKM 用户名", ignoreFocusOut: true })
    )?.trim();
    if (!username) return;
    const creds = await promptCredentialsForAccount(context, serverUrl, username);
    if (!creds) return;
    accounts = addAccount(accounts, serverUrl, username);
    saveAccounts(context, accounts);
    const key = accountKey(serverUrl, username);
    currentKey = findAccount(accounts, key)?.key ?? null;
    setCurrent(currentKey ? findAccount(accounts, currentKey) ?? null : null);
    void context.globalState.update("lkm.currentAccount", currentKey);
    vscode.window.showInformationMessage(`已添加账号 ${username}`);
  }

  // ---- LKM: Switch Account ----
  async function handleSwitchAccount() {
    await _pickAccount();
  }

  // ---- LKM: Remove Account ----
  async function handleRemoveAccount() {
    const acc = await ensureCurrent();
    if (!acc) return;
    const ok = await vscode.window.showWarningMessage(
      `删除账号 ${acc.username}？将移除其凭证与系列映射。`,
      { modal: true },
      "删除"
    );
    if (ok !== "删除") return;
    await clearCredentialsForAccount(context, acc.key);
    tokenManagers.delete(acc.key);
    accounts = removeAccount(accounts, acc.key);
    saveAccounts(context, accounts);
    if (currentKey === acc.key) {
      currentKey = accounts.length ? accounts[0].key : null;
      setCurrent(currentKey ? findAccount(accounts, currentKey) ?? null : null);
      void context.globalState.update("lkm.currentAccount", currentKey);
    }
  }

  // ---- LKM: Clone Blog（归入当前账号）----
  async function handleClone() {
    const acc = await ensureCurrent();
    if (!acc) return;
    const deps: CloneDeps = {
      getConfig: (k) => getConfig(k, ""),
      pickSeries: async (series) => {
        const picked = await vscode.window.showQuickPick(
          series.map((s) => ({ label: s.title, detail: s.repo_name, series: s })),
          { placeHolder: "选择要克隆的 blog 系列" }
        );
        return picked ? picked.series : null;
      },
      pickTargetDir: async () => {
        const dirs = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "选择克隆目标目录",
        });
        return dirs && dirs.length > 0 ? dirs[0].fsPath : undefined;
      },
      doClone: async (url, dir) => {
        // 动态取最终实现，避免顶层副作用。
        const { cloneRepository } = await import("./git");
        await cloneRepository(url, dir);
      },
      afterCloneHint: async (dir) => {
        void vscode.window.showInformationMessage(
          `已克隆。如需可删除 ${dir}/.git/config 中的明文远程口令，或用 git credential helper。`
        );
      },
    };
    const outcome = await runCloneForAccount(context, acc, deps);
    if (outcome.kind === "cloned") {
      persistAccount(outcome.account); // 复用统一写回逻辑，避免与 persistAccount 各改一处。
      vscode.window.showInformationMessage(outcome.message);
    } else if (outcome.kind === "error") {
      vscode.window.showErrorMessage(outcome.message);
    }
  }

  // ---- LKM: Pull / Push（工作区便捷）----
  async function handlePull() {
    const repo = await getActiveGitRepository();
    if (!repo) {
      vscode.window.showWarningMessage("未找到当前 LKM 仓库");
      return;
    }
    try {
      await repo.pull();
    } catch (err) {
      vscode.window.showErrorMessage(`拉取失败：${(err as Error).message}`);
    }
  }
  async function handlePush() {
    const repo = await getActiveGitRepository();
    if (!repo) {
      vscode.window.showWarningMessage("未找到当前 LKM 仓库");
      return;
    }
    try {
      await repo.push();
    } catch (err) {
      vscode.window.showErrorMessage(`推送失败：${(err as Error).message}`);
    }
  }

  // ---- Series CRUD（Bearer）----
  async function handleCreateSeries() {
    const acc = await ensureCurrent();
    if (!acc) return;
    const title = (await vscode.window.showInputBox({ prompt: "系列标题", ignoreFocusOut: true }))?.trim();
    if (!title) return;
    const repoName = (
      await vscode.window.showInputBox({ prompt: "repo_name（如 my-blog）", ignoreFocusOut: true })
    )?.trim();
    if (!repoName) return;
    // 取 token，认证失败会升级为清凭证+重录（spec §4/§10）。
    const tok = await ensureAuthedToken(acc);
    if (!tok) {
      // 网络失败或用户在重录弹窗里取消：必须给反馈，否则命令静默无响应。
      vscode.window.showErrorMessage("未获取到登录凭证，创建已取消");
      return;
    }
    try {
      const s = await createSeries(acc.serverUrl, tok, { title, repo_name: repoName });
      vscode.window.showInformationMessage(`已创建系列 ${s.title}`);
    } catch (err) {
      // API 仍 401（新凭证也可能被拒）：令缓存失效，下次操作再走 ensureAuthedToken 的清凭证升级。
      onAuthError(acc.key, err);
      vscode.window.showErrorMessage(`创建失败：${(err as Error).message}`);
    }
  }

  async function handleDeleteSeries() {
    const acc = await ensureCurrent();
    if (!acc) return;
    const sel = await pickMappedSeries(acc, "选择要删除的系列");
    if (!sel) return;
    const ok = await vscode.window.showWarningMessage(
      `确认删除系列 ${sel.repo}？将删除远端内容并移除本地映射。`,
      { modal: true },
      "删除"
    );
    if (ok !== "删除") return;
    const tok = await ensureAuthedToken(sel.resolved.account);
    if (!tok) return;
    try {
      await deleteSeries(sel.resolved.account.serverUrl, tok, sel.resolved.id);
    } catch (err) {
      onAuthError(sel.resolved.account.key, err);
      vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      return;
    }
    const un = unmapSeries(sel.resolved.account, sel.repo);
    persistAccount(un);
    vscode.window.showInformationMessage(`已删除系列 ${sel.repo}`);
  }

  // 星标：接真实 series id，调 toggleStar。
  async function handleToggleStar() {
    const acc = await ensureCurrent();
    if (!acc) return;
    const sel = await pickMappedSeries(acc, "选择要加星/取消星的系列");
    if (!sel) return;
    const tok = await ensureAuthedToken(sel.resolved.account);
    if (!tok) return;
    try {
      const s = await toggleStar(sel.resolved.account.serverUrl, tok, sel.resolved.id);
      vscode.window.showInformationMessage(s.starred ? `已加星 ${sel.repo}` : `已取消星 ${sel.repo}`);
    } catch (err) {
      onAuthError(sel.resolved.account.key, err);
      vscode.window.showErrorMessage(`星标操作失败：${(err as Error).message}`);
    }
  }

  const subs = context.subscriptions;
  subs.push(register(CLONE_CMD, handleClone));
  subs.push(register(PULL_CMD, handlePull));
  subs.push(register(PUSH_CMD, handlePush));
  subs.push(register(ADD_ACCOUNT_CMD, handleAddAccount));
  subs.push(register(SWITCH_ACCOUNT_CMD, handleSwitchAccount));
  subs.push(register(REMOVE_ACCOUNT_CMD, handleRemoveAccount));
  subs.push(register(CREATE_SERIES_CMD, handleCreateSeries));
  subs.push(register(DELETE_SERIES_CMD, handleDeleteSeries));
  subs.push(register(TOGGLE_STAR_CMD, handleToggleStar));

  // 树 provider 交给 activate 注册到视图。
  return provider;
}

/**
 * 从 globalState 读当前账号（自动同步用，与命令闭包独立）。
 * 无账号或列表为空时返回 null。
 */
function getCurrentAccountFromState(context: vscode.ExtensionContext): AccountMeta | null {
  const accounts = loadAccounts(context);
  const currentKey = (context.globalState.get("lkm.currentAccount") as string | null) ?? null;
  return currentKey ? findAccount(accounts, currentKey) ?? null : null;
}

/**
 * 启动自动同步副作用：定时轮询 pull + 聚焦 pull + 保存 auto-push 决策。
 *
 * - 定时器周期在启动时按配置算一次；每次 tick 再按最新配置决定是否 pull。
 * - pull 只读，失败静默（badge 由 tree provider 展示）。
 * - auto-push 默认关（lkm.autoPush.enabled）；开启时仅触发 gitRemoting 占位。
 * 返回 Disposable，在 activate 的 subscriptions 中注入以便停用时清理。
 */
function startAutoSync(
  _context: vscode.ExtensionContext,
  getCurrentAccount: () => AccountMeta | null
): vscode.Disposable {
  const settings = (): SyncSettings => ({
    pullIntervalMinutes: getConfig("sync.pullIntervalMinutes", 5),
    pullOnFocus: getConfig("sync.pullOnFocus", true),
    autoPushEnabled: getConfig("autoPush.enabled", false),
  });
  let lastRunByDir = new Map<string, number>();

  async function pullOne(dir: string): Promise<void> {
    const git = await getGitByDir(dir);
    if (!git) return;
    try {
      await git.pull();
      lastRunByDir.set(dir, Date.now());
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
    Math.max(getConfig("sync.pullIntervalMinutes", 5), 1) * 60 * 1000
  );

  const onFocus = vscode.window.onDidChangeWindowState((e) => {
    if (e.focused && settings().pullOnFocus) void pullAll();
  });

  // auto-commit/push 尚未实现：首次触发时显式告知一次，避免用户以为保存已被提交推送。
  let autoPushWarned = false;
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    const cfg = settings();
    if (!cfg.autoPushEnabled) return;
    const acc = getCurrentAccount();
    if (!acc || !doc.fileName) return;
    const dir = pathBelongsToAccount(doc.fileName, acc);
    if (!dir) return;
    if (!autoPushWarned) {
      autoPushWarned = true;
      void vscode.window.showWarningMessage(
        "lkm.autoPush.enabled 尚未实现自动提交/推送，保存文件不会产生任何 git 操作"
      );
    }
    void getGitByDir(dir)
      .then((git) => (git ? gitRemoting(git, cfg) : undefined))
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

/**
 * auto-push：add -A + commit + push。
 *
 * 占位：GitRepositoryHandle 只有 pull/push，缺少 add/commit 能力。
 * 实际 auto-commit+push 需要 git.ts 扩展 commitAndPush（add -A + commit "lkm: auto-sync" + push），
 * 属明确后续项，本版不假实现。该函数仅在 autoPush 开启（默认关）时才会被调用，
 * 调用方已在首次触发时给出「尚未实现」的显式提示，避免静默无效果。
 */
async function gitRemoting(_git: { pull(): Promise<void>; push(): Promise<void> }, _cfg: SyncSettings): Promise<void> {
  // 占位：git.ts 需扩展 commitAndPush（add -A + commit "lkm: auto-sync" + push）在此接线。
}

/** 扩展激活入口：以真实实现注册命令与树视图，并启动自动同步。 */
export function activate(context: vscode.ExtensionContext): void {
  // 账号持久化交给 registerCommands 内部闭包；此处注册 provider 与命令。
  const provider = registerCommands(context, vscode.commands.registerCommand.bind(vscode.commands), []);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(MANAGE_SERIES_VIEW, provider),
    // provider 持有 EventEmitter，随扩展停用一起 dispose，避免重建时泄漏监听。
    provider
  );
  // 注册自动同步副作用，随停用一起清理。
  context.subscriptions.push(
    startAutoSync(context, () => getCurrentAccountFromState(context))
  );
}

/** 扩展停用入口：无需清理。 */
export function deactivate(): void {
  // 无清理逻辑。
}
