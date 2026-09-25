import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  registerCommands,
  PULL_CMD,
  PUSH_CMD,
  CLONE_CMD,
  ADD_ACCOUNT_CMD,
  SWITCH_ACCOUNT_CMD,
  REMOVE_ACCOUNT_CMD,
  CREATE_SERIES_CMD,
  DELETE_SERIES_CMD,
  TOGGLE_STAR_CMD,
  MANAGE_SERIES_VIEW,
} from "../src/extension";
import { AccountMeta, accountKey } from "../src/accounts";
import { __inputBoxQueue } from "./mocks/vscode";

describe("extension", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registerCommands 注册三个 LKM 命令", () => {
    const registered: string[] = [];
    const fakeRegister = (id: string) => {
      registered.push(id);
      return { dispose() {} } as { dispose(): void };
    };
    registerCommands(
      {
        subscriptions: { push() {} },
        globalState: { get: () => [], update: async () => {} },
      } as never,
      fakeRegister as never,
      [] as never
    );
    expect(registered).toContain(CLONE_CMD);
    expect(registered).toContain(PULL_CMD);
    expect(registered).toContain(PUSH_CMD);
  });

  it("registerCommands 注册新增命令并返回 provider", () => {
    const registered: string[] = [];
    const fakeRegister = (id: string) => {
      registered.push(id);
      return { dispose() {} } as { dispose(): void };
    };
    const provider = registerCommands(
      {
        subscriptions: { push() {} },
        globalState: { get: () => [], update: async () => {} },
      } as never,
      fakeRegister as never,
      [] as never
    ) as { refresh: () => void };
    for (const c of [
      CLONE_CMD,
      PULL_CMD,
      PUSH_CMD,
      ADD_ACCOUNT_CMD,
      SWITCH_ACCOUNT_CMD,
      REMOVE_ACCOUNT_CMD,
      CREATE_SERIES_CMD,
      DELETE_SERIES_CMD,
      TOGGLE_STAR_CMD,
    ]) {
      expect(registered).toContain(c);
    }
    expect(provider).toBeDefined();
    expect(typeof provider.refresh).toBe("function");
  });
});

/**
 * Fix 1（spec §4/§10）集成测试：401 需升级为「清凭证 + 重新引导输入」，
 * 而不是对限流的 /auth/login/password 持续硬撞。
 *
 * 流程：创建系列 → 首次用旧凭证换 token 返回 401 → 重新录入密码 →
 * 用新凭证重建 TokenManager 重试成功 → 继续创建系列 API 调用。
 */
describe("extension 401 升级", () => {
  const CRED_PREFIX = "lkm.blog.credentials.";
  const key = accountKey("https://h", "alice"); // "https://h:alice"
  const credKey = CRED_PREFIX + Buffer.from(key).toString("base64");

  function jsonResp(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("login 401 时清除旧凭证并引导重新录入后重试成功", async () => {
    __inputBoxQueue.length = 0;
    // 队列顺序：创建系列的标题、repo_name，随后密码录入（showInputBox 沿用同一队列）。
    __inputBoxQueue.push("My Blog", "my-blog", "newpw");

    // 凭证存储：初始有旧密码，clear 会删除、prompt 会写回新密码。
    const secretsStore = new Map<string, string>([[credKey, "alice\u0000oldpw"]]);
    const secrets = {
      get: vi.fn((k: string) => Promise.resolve(secretsStore.get(k) ?? undefined)),
      store: vi.fn(async (k: string, v: string) => { secretsStore.set(k, v); }),
      delete: vi.fn(async (k: string) => { secretsStore.delete(k); }),
    };

    // 全局账号状态：一个已添加账号 alice，且为当前账号。
    const account: AccountMeta = {
      key,
      serverUrl: "https://h",
      username: "alice",
      series: {},
    };
    const globalState = {
      get: vi.fn((k: string) => {
        if (k === "lkm.accounts") return [account];
        if (k === "lkm.currentAccount") return key;
        return undefined;
      }),
      update: vi.fn(async () => {}),
    };

    // fetch 调用序列：
    //  1) ensureAuthedToken 首次 login（旧凭证）→ 401
    //  2) 重建后用新凭证 login → ok
    //  3) createSeries API → ok
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 401, message: "Unauthorized", data: null }, 401))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok2" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { id: 9, title: "My Blog", repo_name: "my-blog", status: "ACTIVE" } }));
    vi.stubGlobal("fetch", fetchMock);

    // 捕获各命令回调，手动驱动 createSeries handler。
    const callbacks = new Map<string, (...args: never[]) => unknown>();
    const fakeRegister = (id: string, cb: (...args: never[]) => unknown) => {
      callbacks.set(id, cb);
      return { dispose() {} } as { dispose(): void };
    };

    registerCommands(
      { subscriptions: { push() {} }, globalState, secrets } as never,
      fakeRegister as never,
      [] as never
    );

    const handler = callbacks.get(CREATE_SERIES_CMD)!;
    await handler();

    // 旧凭证被清除（不存在 oldpw 值），新密码已回写。
    const stored = secretsStore.get(credKey) ?? "";
    expect(stored).not.toContain("oldpw");
    expect(stored).toContain("newpw");
    // 密码录入走了一次 showInputBox。
    expect(secrets.store).toHaveBeenCalledTimes(1);
    // 总 fetch：401 一次 + 新凭证兑换一次 + 创建系列一次，未对 login 无限重试。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});

describe("extension 删除系列 / 星标", () => {
  const key = accountKey("https://h", "alice");
  const account: AccountMeta = {
    key,
    serverUrl: "https://h",
    username: "alice",
    series: { "my-blog": { dir: "C:/x/my-blog", id: 5 } },
  };

  function jsonResp(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function makeEnv() {
    const globalState = {
      get: vi.fn((k: string) => {
        if (k === "lkm.accounts") return [account];
        if (k === "lkm.currentAccount") return key;
        return undefined;
      }),
      update: vi.fn(async () => {}),
    };
    const callbacks = new Map<string, (...args: never[]) => unknown>();
    const fakeRegister = (id: string, cb: (...args: never[]) => unknown) => {
      callbacks.set(id, cb);
      return { dispose() {} } as { dispose(): void };
    };
    const secrets = {
      get: vi.fn(async () => "alice\u0000pw"),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    registerCommands(
      { subscriptions: { push() {} }, globalState, secrets } as never,
      fakeRegister as never,
      [] as never
    );
    return { callbacks, globalState };
  }

  it("删除系列：确认后调 DELETE /series/5 并移除本地映射", async () => {
    const env = makeEnv();
    // showQuickPick 选中系列；showWarningMessage 确认返回 "删除"
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "my-blog", repo: "my-blog" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("删除" as never);
    // fetch 序列：login 换 token → deleteSeries（有 id，故不调 listSeries）
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: null }));
    vi.stubGlobal("fetch", fetchMock);

    const handler = env.callbacks.get(DELETE_SERIES_CMD)!;
    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls.some((u) => u.endsWith("/api/v1/blog/series/5"))).toBe(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("星标：调 POST /series/5/star 并按 starred 反馈", async () => {
    const env = makeEnv();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "my-blog", repo: "my-blog" } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { starred: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const handler = env.callbacks.get(TOGGLE_STAR_CMD)!;
    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls.some((u) => u.endsWith("/api/v1/blog/series/5/star"))).toBe(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("映射缺 id 时反查 listSeries 并回写 id 后再删除", async () => {
    const missingId: AccountMeta = {
      key,
      serverUrl: "https://h",
      username: "alice",
      series: { "my-blog": { dir: "C:/x/my-blog" } }, // 无 id（旧结构/手抹）
    };
    const globalState = {
      get: vi.fn((k: string) => {
        if (k === "lkm.accounts") return [missingId];
        if (k === "lkm.currentAccount") return key;
        return undefined;
      }),
      update: vi.fn(async () => {}),
    };
    const callbacks = new Map<string, (...args: never[]) => unknown>();
    const fakeRegister = (id: string, cb: (...args: never[]) => unknown) => {
      callbacks.set(id, cb);
      return { dispose() {} } as { dispose(): void };
    };
    const secrets = { get: vi.fn(async () => "alice\u0000pw"), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    registerCommands(
      { subscriptions: { push() {} }, globalState, secrets } as never,
      fakeRegister as never,
      [] as never
    );
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "my-blog", repo: "my-blog" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("删除" as never);
    // fetch 序列：login → listSeries(反查得 id=5) → deleteSeries
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { items: [{ id: 5, title: "My Blog", repo_name: "my-blog", status: "ACTIVE" }] } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: null }));
    vi.stubGlobal("fetch", fetchMock);

    const handler = callbacks.get(DELETE_SERIES_CMD)!;
    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 含一次 listSeries 反查（GET /blog/series）
    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls.some((u) => u.includes("/api/v1/blog/series") && !/series\/\d+/.test(u))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/v1/blog/series/5"))).toBe(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("映射缺 id 且反查未命中 → 提示，不发删除请求", async () => {
    // 无 id 账号：反查 listSeries 返回空 items → ensureSeriesId 返回 null → 提示不发 DELETE
    const missingId: AccountMeta = {
      key,
      serverUrl: "https://h",
      username: "alice",
      series: { "my-blog": { dir: "C:/x/my-blog" } },
    };
    const globalState = {
      get: vi.fn((k: string) => {
        if (k === "lkm.accounts") return [missingId];
        if (k === "lkm.currentAccount") return key;
        return undefined;
      }),
      update: vi.fn(async () => {}),
    };
    const callbacks = new Map<string, (...args: never[]) => unknown>();
    const fakeRegister = (id: string, cb: (...args: never[]) => unknown) => {
      callbacks.set(id, cb);
      return { dispose() {} } as { dispose(): void };
    };
    const secrets = { get: vi.fn(async () => "alice\u0000pw"), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    registerCommands(
      { subscriptions: { push() {} }, globalState, secrets } as never,
      fakeRegister as never,
      [] as never
    );
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "my-blog", repo: "my-blog" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("删除" as never);
    // fetch 序列：login 换 token → listSeries 返回空 items（反查未命中）
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = callbacks.get(DELETE_SERIES_CMD)!;
    await handler();
    // 只有 login + listSeries，无 DELETE（不发无效请求）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

/**
 * Fix Finding-1：旧版持久化到 globalState 的系列值是裸 string（目录路径），
 * 升级到 { dir, id? } 新结构后读取旧数据不得崩溃，且能正常删除/星标。
 */
describe("extension 迁移旧系列 string 值", () => {
  const key = accountKey("https://h", "alice");
  // 旧账号数据：series 值为裸 string（v0.2 持久化形态）。
  const legacyAccount = {
    key,
    serverUrl: "https://h",
    username: "alice",
    series: { "my-blog": "C:/x/my-blog" },
  };

  function jsonResp(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function makeEnv() {
    const globalState = {
      get: vi.fn((k: string) => {
        if (k === "lkm.accounts") return [legacyAccount];
        if (k === "lkm.currentAccount") return key;
        return undefined;
      }),
      update: vi.fn(async () => {}),
    };
    const callbacks = new Map<string, (...args: never[]) => unknown>();
    const fakeRegister = (id: string, cb: (...args: never[]) => unknown) => {
      callbacks.set(id, cb);
      return { dispose() {} } as { dispose(): void };
    };
    const secrets = { get: vi.fn(async () => "alice\u0000pw"), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    registerCommands(
      { subscriptions: { push() {} }, globalState, secrets } as never,
      fakeRegister as never,
      [] as never
    );
    return { callbacks, globalState };
  }

  it("旧 string 系列值不崩溃且可正常删除（迁移为 {dir} 后反查 id）", async () => {
    const env = makeEnv();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "my-blog", repo: "my-blog" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("删除" as never);
    // 迁移成 { dir }（无 id）→ 走反查路径：login → listSeries → deleteSeries
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { access_token: "tok" } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: { items: [{ id: 5, title: "My Blog", repo_name: "my-blog", status: "ACTIVE" }] } }))
      .mockResolvedValueOnce(jsonResp({ code: 0, message: "ok", data: null }));
    vi.stubGlobal("fetch", fetchMock);

    const handler = env.callbacks.get(DELETE_SERIES_CMD)!;
    await handler();

    // 不崩溃；触发反查删除。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls.some((u) => u.endsWith("/api/v1/blog/series/5"))).toBe(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
