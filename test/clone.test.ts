import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serverUrlFromConfig, runCloneFlow, CloneDeps, runCloneForAccount } from "../src/clone";
import { AccountMeta } from "../src/accounts";
import { saveCredentialsForAccount } from "../src/creds";
import { listSeries, BlogSeries } from "../src/api";
import { __inputBoxQueue } from "./mocks/vscode";

// 在顶层 mock ../src/api：保留 gitCloneUrl（runCloneFlow 依赖它拼 URL），
// listSeries 替换为可控的 vi.fn，供各用例注入返回/抛错。
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/api")
  >();
  return {
    ...actual,
    listSeries: vi.fn(),
  };
});

/**
 * 构造一个可控的 ExtensionContext 形状：secrets.get 由传入的初始值决定，
 * store/delete 走 Map 回路。getResult === undefined 表示无已存凭证。
 */
function makeContext(getResult: string | undefined) {
  const store = new Map<string, string>();
  if (getResult !== undefined) store.set("lkm.blog.credentials", getResult);
  const secrets = {
    get: vi.fn((_k: string) => Promise.resolve(store.get("lkm.blog.credentials") ?? undefined)),
    store: vi.fn((_k: string, v: string) => {
      store.set("lkm.blog.credentials", v);
      return Promise.resolve();
    }),
    delete: vi.fn((_k: string) => {
      store.delete("lkm.blog.credentials");
      return Promise.resolve();
    }),
  };
  return { context: { secrets }, __store: store } as any;
}

/** 默认的系列列表与一个可配置的 deps 工厂。 */
const SERIES: BlogSeries[] = [
  { id: 1, title: "我的博客", repo_name: "myblog", status: "ACTIVE" },
];

function makeDeps(overrides: Partial<CloneDeps> = {}): CloneDeps {
  return {
    getConfig: (k) => (k === "lkm.serverUrl" ? "https://h/" : undefined),
    pickSeries: vi.fn(async () => SERIES[0]),
    pickTargetDir: vi.fn(async () => "/target/dir"),
    doClone: vi.fn(async () => "/target/dir/myblog"),
    ...overrides,
  };
}

describe("runCloneFlow", () => {
  beforeEach(() => {
    __inputBoxQueue.length = 0; // 清空可注入的输入队列
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无已存凭证且 prompt 返回空 → cancelled（未提供凭证）", async () => {
    const { context } = makeContext(undefined);
    // 两次输入框都无输入 → prompt 返回空对象
    __inputBoxQueue.push(undefined, undefined);
    const deps = makeDeps();
    const outcome = await runCloneFlow(context, deps);
    expect(outcome).toEqual({ kind: "cancelled", message: "未提供凭证" });
    expect(deps.doClone).not.toHaveBeenCalled();
  });

  it("有已存凭证（有效 user/pass）→ 走完全流程 cloned，doClone 收到含 Basic 的 URL", async () => {
    const { context } = makeContext("alice\u0000s3cret");
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERIES);
    const doClone = vi.fn(async () => "/target/dir/myblog");
    const deps = makeDeps({ doClone });
    const outcome = await runCloneFlow(context, deps);
    expect(outcome.kind).toBe("cloned");
    expect(doClone).toHaveBeenCalledTimes(1);
    // gitCloneUrl 裸 URL = https://h/api/v1/blog/git/myblog.git，embedBasicAuth 后内联 Basic 凭证
    const url = (doClone.mock.calls[0][0] as string);
    expect(url.startsWith("https://alice:s3cret@")).toBe(true);
    expect(url).toContain("/api/v1/blog/git/myblog.git");
    // 目录与系列正确
    expect(doClone.mock.calls[0][1]).toBe("/target/dir");
    expect((outcome as any).message).toContain("我的博客");
  });

  it("已存空密码 \"alice\\u0000\" 读回应视为无凭证 → 走 prompt 分支（不直接用空密码）", async () => {
    const { context } = makeContext("alice\u0000");
    // 关键：prompt 返回空 → cancelled，说明没有用空密码继续，而是进入录入分支
    __inputBoxQueue.push(undefined, undefined);
    const deps = makeDeps();
    const outcome = await runCloneFlow(context, deps);
    expect(outcome).toEqual({ kind: "cancelled", message: "未提供凭证" });
    // listSeries 不应被调用（未走到列系列步骤）
    expect(listSeries).not.toHaveBeenCalled();
    expect(deps.doClone).not.toHaveBeenCalled();
  });

  it("listSeries 抛错 → error", async () => {
    const { context } = makeContext("alice\u0000s3cret");
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("网络挂了"));
    const deps = makeDeps();
    const outcome = await runCloneFlow(context, deps);
    expect(outcome.kind).toBe("error");
    expect((outcome as any).message).toContain("列系列失败");
  });

  it("选系列取消 → cancelled", async () => {
    const { context } = makeContext("alice\u0000s3cret");
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERIES);
    const deps = makeDeps({ pickSeries: vi.fn(async () => null) });
    const outcome = await runCloneFlow(context, deps);
    expect(outcome).toEqual({ kind: "cancelled", message: "未选择系列" });
  });

  it("目标目录取消 → cancelled", async () => {
    const { context } = makeContext("alice\u0000s3cret");
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERIES);
    const deps = makeDeps({ pickTargetDir: vi.fn(async () => undefined) });
    const outcome = await runCloneFlow(context, deps);
    expect(outcome).toEqual({ kind: "cancelled", message: "未选择目标目录" });
  });

  it("doClone 抛错 → error", async () => {
    const { context } = makeContext("alice\u0000s3cret");
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERIES);
    const deps = makeDeps({ doClone: vi.fn(async () => { throw new Error("克隆超时"); }) });
    const outcome = await runCloneFlow(context, deps);
    expect(outcome.kind).toBe("error");
    expect((outcome as any).message).toContain("克隆失败");
  });
});

describe("clone", () => {
  it("serverUrlFromConfig 返回去尾斜杠的 URL", () => {
    expect(serverUrlFromConfig((k) => (k === "lkm.serverUrl" ? "https://h/" : ""))).toBe("https://h");
  });

  it("serverUrlFromConfig 空配置抛错", () => {
    expect(() => serverUrlFromConfig(() => "")).toThrow();
  });
});

describe("clone (按账号)", () => {
  const account: AccountMeta = {
    key: "https://h:alice",
    serverUrl: "https://h",
    username: "alice",
    series: {},
  };

  function deps(over: Partial<CloneDeps> = {}): CloneDeps {
    return {
      getConfig: (k) => (k === "lkm.serverUrl" ? "https://h" : ""),
      pickSeries: async () => ({ id: 1, title: "我的博客", repo_name: "my-blog", status: "ACTIVE" }),
      pickTargetDir: async () => "C:/x",
      doClone: async () => "C:/x/my-blog",
      ...over,
    };
  }

  beforeEach(() => {
    // 顶层 vi.mock 已用 vi.fn 替换 listSeries，默认返回 undefined；
    // 本组用例需要有效的系列列表，统一复位为单条。
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockReset();
    (listSeries as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, title: "我的博客", repo_name: "my-blog", status: "ACTIVE" },
    ]);
  });

  it("用账号凭证 clone 并返回映射信息", async () => {
    const store: Record<string, string> = {};
    const ctx = {
      secrets: {
        get: async (k: string) => store[k] ?? undefined,
        store: async (k: string, v: string) => { store[k] = v; },
        delete: async () => {},
      },
    } as never;
    // 预置该账号密码到 SecretStorage（key 为账号 key 的 base64）
    await saveCredentialsForAccount(ctx, account.key, "alice", "secretpw");
    const doClone = vi.fn().mockResolvedValue("C:/x/my-blog");
    const afterCloneHint = vi.fn();

    const out = await runCloneForAccount(ctx, account, deps({ doClone, afterCloneHint }));
    expect(out.kind).toBe("cloned");
    if (out.kind === "cloned") {
      expect(out.series.repo_name).toBe("my-blog");
      expect(out.series.dir).toBe("C:/x/my-blog");
      // 核心交付：新系列已写回账号映射，值为含 dir 与 id 的对象
      expect(out.account.series["my-blog"]).toEqual({ dir: "C:/x/my-blog", id: 1 });
      expect(out.series.id).toBe(1); // clone 顺带写后端 id
      expect(doClone).toHaveBeenCalledOnce();
      expect(doClone.mock.calls[0][1]).toBe("C:/x");
      expect(afterCloneHint).toHaveBeenCalledWith("C:/x/my-blog");
      const url = doClone.mock.calls[0][0] as string;
      expect(url).toContain("/api/v1/blog/git/my-blog.git");
      expect(url.startsWith("https://alice:secretpw@h/")).toBe(true);
    }
  });

  it("无凭证时提示录入，取消则 cancelled", async () => {
    const store: Record<string, string> = {};
    const ctx = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as never;
    const out = await runCloneForAccount(ctx, account, deps({ doClone: async () => "C:/x/my-blog" }));
    expect(out.kind).toBe("cancelled");
    expect(store).not.toHaveProperty("__never"); // secret 无残留
  });
});
