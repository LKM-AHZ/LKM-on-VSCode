import { describe, it, expect, vi, afterEach } from "vitest";
import { listSeries, gitCloneUrl, createSeries, deleteSeries, toggleStar } from "../src/api";

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listSeries 解包 ApiResp 并取 data.items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          data: {
            items: [
              { id: 1, title: "我的博客", repo_name: "my-blog", status: "ACTIVE" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const series = await listSeries("https://x", "Basic abc");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ id: 1, repo_name: "my-blog", status: "ACTIVE" });
    // 校验请求 URL 与 Authorization 头
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/blog/series");
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Basic abc");
  });

  it("listSeries 过滤非 ACTIVE 系列", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          data: {
            items: [
              { id: 1, title: "a", repo_name: "a", status: "ACTIVE" },
              { id: 2, title: "b", repo_name: "b", status: "ARCHIVED" },
            ],
          },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const series = await listSeries("https://x", "Basic abc");
    expect(series).toHaveLength(1);
    expect(series[0].id).toBe(1);
  });

  it("listSeries 对非 200 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("auth fail", { status: 401 }))
    );
    await expect(listSeries("https://x", "Basic abc")).rejects.toThrow();
  });

  it("gitCloneUrl 拼出裸仓库 URL", () => {
    // 第 3、4 参为 username/password（签名预留，暂未内联），repoName 为真正的仓库名
    expect(gitCloneUrl("https://host", "post", "pass", "my-blog")).toBe(
      "https://host/api/v1/blog/git/my-blog.git"
    );
  });
});

describe("api CRUD", () => {
  function jsonResp(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("createSeries POST /series 带访问令牌", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({ code: 0, message: "ok", data: { id: 9, title: "t", repo_name: "r", status: "ACTIVE" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await createSeries("https://h", "tok", { title: "t", repo_name: "r" });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/blog/series");
    expect(call[1].method).toBe("POST");
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(call[1].body as string)).toEqual({ title: "t", repo_name: "r" });
    vi.unstubAllGlobals();
  });

  it("deleteSeries DELETE /series/{id} 带 Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({ code: 0, message: "ok", data: null }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteSeries("https://h", "tok", 42);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/blog/series/42");
    expect(call[1].method).toBe("DELETE");
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
    vi.unstubAllGlobals();
  });

  it("toggleStar POST /series/{id}/star 带 Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({ code: 0, message: "ok", data: { starred: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const s = await toggleStar("https://h", "tok", 7);
    expect(s.starred).toBe(true);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/blog/series/7/star");
    expect(call[1].method).toBe("POST");
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
    vi.unstubAllGlobals();
  });

  it("createSeries 非 ok 抛 Error(msg)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({ code: 1001, message: "标题重复", data: null }, 400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSeries("https://h", "tok", { title: "t", repo_name: "r" })).rejects.toThrow("标题重复");
    vi.unstubAllGlobals();
  });

  it("createSeries 非 0 code 抛 Error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({ code: 2000, message: "未授权", data: null }, 200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSeries("https://h", "tok", { title: "t", repo_name: "r" })).rejects.toThrow("未授权");
    vi.unstubAllGlobals();
  });

  it("deleteSeries 非 ok 抛 Error(msg)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({ code: 404, message: "不存在", data: null }, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteSeries("https://h", "tok", 99)).rejects.toThrow("不存在");
    vi.unstubAllGlobals();
  });
});
