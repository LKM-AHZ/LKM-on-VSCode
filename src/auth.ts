import { basicHeader } from "./creds";

export interface RestAuthDeps {
  serverUrl: string;
  getCredentials(): Promise<{ username: string; password: string } | null>;
  fetchFn?: typeof fetch;
}

/** 解包 ApiResp 并返回 data 的通用辅助。 */
async function unpack<T>(res: Response): Promise<T> {
  // 先取文本再解析：401/5xx/网关错误页常返回空体或 HTML，直接 res.json() 会抛 SyntaxError
  // 掩盖掉真正的 HTTP 状态码与服务端 msg。
  const raw = await res.text().catch(() => "");
  let body: { code: number; msg: string; data: T | null } | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as { code: number; msg: string; data: T | null };
    } catch {
      body = null;
    }
  }
  if (!res.ok || !body || body.code !== 0 || body.data === null) {
    throw new Error(body?.msg || `HTTP ${res.status}`);
  }
  return body.data;
}

/**
 * 用用户名+密码换 Bearer access token（POST /auth/login/password）。
 * fetchFn 供测试注入。
 */
export async function loginForToken(
  serverUrl: string,
  username: string,
  password: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/v1/auth/login/password`;
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basicHeader(username, password),
      },
      body: JSON.stringify({ username, password }),
    });
    const data = await unpack<{ access_token: string }>(res);
    return data.access_token;
  } catch (err) {
    // fetch 自身失败（网络/DNS）或解包失败往往只有 "fetch failed" 这类泛化信息，
    // 补上目标地址与用户名便于在扩展宿主里定位是哪个账号登录失败。
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`登录失败 (${url}, 用户 ${username}): ${reason}`);
  }
}

export interface TokenManager {
  getToken(): Promise<string | null>;
  invalidate(): void;
  /** 最近一次成功兑换 token 的时间戳（毫秒）；从未兑换过返回 null。 */
  lastTokenAt(): number | null;
}

/** access_token 的生命周期（毫秒），对齐后端 15 分钟。超时即视为过期。 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * 客户端提前量：本地时钟可能比服务端慢（或在 token 即将到期时才发出请求），
 * 与服务端 15 分钟窗口等长会导致复用一个服务端已判过期的 token，故提前 60s 重兑。
 */
export const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

/**
 * 凭证→token 缓存管理器：复用 token 规避登录限流，401 时 invalidate 触发重兑。
 *
 * token 有 15 分钟有效期：超过该窗口后，即便未收到 401，下次 getToken 也会
 * 视为过期并重新兑换（避免使用已失效的 Bearer）。cachedAt 记录最近一次成功
 * 兑换的时刻，供 lastTokenAt() 判断会话活跃度。
 */
export function createTokenManager(deps: RestAuthDeps): TokenManager {
  let cached: string | null = null;
  let cachedAt: number | null = null;
  // 正在进行的兑换：并发调用共用同一个 Promise，避免同时打多次 /auth/login/password 触发限流。
  let pending: Promise<string | null> | null = null;
  const fetchFn = deps.fetchFn ?? fetch;
  return {
    async getToken() {
      // 已缓存且未过期则复用；过期则清除后重兑。
      if (
        cached &&
        cachedAt !== null &&
        Date.now() - cachedAt < TOKEN_TTL_MS - TOKEN_SAFETY_MARGIN_MS
      ) {
        return cached;
      }
      if (pending) return pending;
      cached = null;
      cachedAt = null;
      pending = (async () => {
        const creds = await deps.getCredentials();
        if (!creds) return null;
        const token = await loginForToken(deps.serverUrl, creds.username, creds.password, fetchFn);
        cached = token;
        cachedAt = Date.now();
        return token;
      })();
      try {
        return await pending;
      } finally {
        pending = null;
      }
    },
    invalidate() {
      cached = null;
      cachedAt = null;
    },
    lastTokenAt() {
      return cachedAt;
    },
  };
}
