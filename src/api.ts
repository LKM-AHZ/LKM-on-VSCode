export interface BlogSeries {
  id: number;
  title: string;
  repo_name: string;
  status: string;
}

interface ApiResp<T> {
  code: number;
  message: string;
  data: T | null;
  request_id?: string;
}

interface ListData<T> {
  items: T[];
  total?: number;
}

/**
 * 拉取 blog 系列列表并解包 ApiResp。
 * 仅返回 status 为 "ACTIVE" 的系列。
 */
export async function listSeries(
  serverUrl: string,
  authHeader: string
): Promise<BlogSeries[]> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/v1/blog/series`;
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as ApiResp<ListData<BlogSeries>>;
  if (body.code !== 0 || !body.data) {
    throw new Error(body.message || "系列列表接口返回错误");
  }
  return body.data.items.filter((s) => s.status === "ACTIVE");
}

/**
 * 拼出 blog 系列的克隆仓库 URL（裸 URL，不含内联凭证）。
 * _username/_password 为签名预留，供后续 embedBasicAuth 使用。
 */
export function gitCloneUrl(
  serverUrl: string,
  _username: string,
  _password: string,
  repoName: string
): string {
  return `${serverUrl.replace(/\/$/, "")}/api/v1/blog/git/${encodeURIComponent(repoName)}.git`;
}

/** 通用请求：带 Bearer，POST/PUT/DELETE 走 json body；解包 ApiResp 返回 data（无体时为 null）。 */
async function authed<T>(
  serverUrl: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T | null> {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  // 先取文本再解析：DELETE 常见的 204/空体，以及网关 HTML 错误页都不该被当成 JSON 解析失败。
  const raw = await res.text().catch(() => "");
  let body: ApiResp<T> | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as ApiResp<T>;
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
  if (body && body.code !== 0)
    throw new Error(body.message || `HTTP ${res.status}`);
  return body ? body.data : null;
}

export async function createSeries(
  serverUrl: string,
  token: string,
  input: { title: string; repo_name: string }
): Promise<BlogSeries> {
  const data = await authed<BlogSeries>(serverUrl, token, "/api/v1/blog/series", {
    method: "POST",
    body: input,
  });
  // 声明返回非空：data 为 null 时在此报错，而不是让调用方在后面收到无关的 TypeError。
  if (!data) throw new Error("创建系列失败：服务端未返回系列数据");
  return data;
}

export async function deleteSeries(serverUrl: string, token: string, id: number): Promise<void> {
  await authed<unknown>(serverUrl, token, `/api/v1/blog/series/${id}`, { method: "DELETE" });
}

export async function toggleStar(
  serverUrl: string,
  token: string,
  id: number
): Promise<{ starred: boolean }> {
  const data = await authed<{ starred: boolean }>(
    serverUrl,
    token,
    `/api/v1/blog/series/${id}/star`,
    { method: "POST" }
  );
  if (!data) throw new Error("星标失败：服务端未返回结果");
  return data;
}
