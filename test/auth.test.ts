import { describe, it, expect, vi } from "vitest";
import { createTokenManager, loginForToken, TOKEN_TTL_MS } from "../src/auth";

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth", () => {
  it("loginForToken 返回 access_token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResp({ code: 0, message: "ok", data: { access_token: "abc" } })
    );
    const t = await loginForToken("https://h", "alice", "pw", fetchFn as never);
    expect(t).toBe("abc");
    const call = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/auth/login/password");
    expect((JSON.parse(call[1].body as string) as Record<string, string>).username).toBe("alice");
  });

  it("loginForToken 非 0 code 抛错", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResp({ code: 1001, message: "bad", data: null }));
    await expect(loginForToken("https://h", "a", "pw", fetchFn as never)).rejects.toThrow("bad");
  });

  it("createTokenManager 缓存复用，不重复调 login", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResp({ code: 0, message: "ok", data: { access_token: "tok1" } })
    );
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => ({ username: "alice", password: "pw" }), fetchFn: fetchFn as never });
    const a = await m.getToken();
    const b = await m.getToken();
    expect(a).toBe("tok1");
    expect(b).toBe("tok1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("invalidate 后重新换 token", async () => {
    let n = 0;
    const fetchFn = vi.fn().mockImplementation(async () => jsonResp({ code: 0, message: "ok", data: { access_token: `t${++n}` } }));
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => ({ username: "alice", password: "pw" }), fetchFn: fetchFn as never });
    expect(await m.getToken()).toBe("t1");
    m.invalidate();
    expect(await m.getToken()).toBe("t2");
  });

  it("无凭证时 getToken 返回 null", async () => {
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => null, fetchFn: vi.fn() as never });
    expect(await m.getToken()).toBeNull();
  });

  it("缓存 token 15 分钟内复用，不重复调 login", async () => {
    let n = 0;
    const fetchFn = vi.fn().mockImplementation(async () => jsonResp({ code: 0, message: "ok", data: { access_token: `t${++n}` } }));
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => ({ username: "alice", password: "pw" }), fetchFn: fetchFn as never });
    expect(await m.getToken()).toBe("t1");
    expect(await m.getToken()).toBe("t1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(m.lastTokenAt()).not.toBeNull();
    expect(m.lastTokenAt()!).toBeLessThanOrEqual(Date.now());
  });

  it("token 超过 15 分钟过期则重新兑换", async () => {
    let n = 0;
    const fetchFn = vi.fn().mockImplementation(async () => jsonResp({ code: 0, message: "ok", data: { access_token: `t${++n}` } }));
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => ({ username: "alice", password: "pw" }), fetchFn: fetchFn as never });
    const first = await m.getToken();
    expect(first).toBe("t1");
    // 把 cachedAt 伪造回 15 分钟之前，模拟缓存已过期。
    vi.spyOn(Date, "now").mockReturnValueOnce(Date.now() + TOKEN_TTL_MS);
    const second = await m.getToken();
    expect(second).toBe("t2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("lastTokenAt 未兑换过返回 null", () => {
    const m = createTokenManager({ serverUrl: "https://h", getCredentials: async () => null, fetchFn: vi.fn() as never });
    expect(m.lastTokenAt()).toBeNull();
  });
});
