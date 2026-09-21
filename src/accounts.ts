/** 系列映射的单个条目：本地目录 + 可选后端系列 id。 */
export interface SeriesEntry {
  dir: string; // 本地目录绝对路径
  id?: number; // 后端 series.id（clone 时写入；旧映射缺失）
}

/** 系列映射：repo_name → 系列条目。 */
export interface SeriesMap {
  [repoName: string]: SeriesEntry;
}

/** 账号元数据（凭证不在此，凭证存 SecretStorage）。 */
export interface AccountMeta {
  key: string; // accountKey(serverUrl, username)
  serverUrl: string;
  username: string;
  series: SeriesMap;
}

/** 账号的唯一标识：serverUrl:username。 */
export function accountKey(serverUrl: string, username: string): string {
  return `${serverUrl.replace(/\/+$/, "")}:${username}`;
}

function mkAccount(serverUrl: string, username: string): AccountMeta {
  return { key: accountKey(serverUrl, username), serverUrl, username, series: {} };
}

/** 全量账号列表。 */
export function listAccounts(accounts: AccountMeta[]): AccountMeta[] {
  return accounts;
}

/** 按 key 找账号。 */
export function findAccount(accounts: AccountMeta[], key: string): AccountMeta | undefined {
  return accounts.find((a) => a.key === key);
}

/** 追加账号；同 key 已存在则替换（更新 serverUrl/username 冗余字段），去重。 */
export function addAccount(accounts: AccountMeta[], serverUrl: string, username: string): AccountMeta[] {
  const key = accountKey(serverUrl, username);
  const existing = findAccount(accounts, key);
  // 重复添加同一账号时要保留已有 series 映射：`mkAccount` 会给空映射，
  // 直接替换会把用户已克隆的系列映射全部抹掉。
  const fresh: AccountMeta = existing
    ? { ...existing, key, serverUrl, username }
    : mkAccount(serverUrl, username);
  const rest = accounts.filter((a) => a.key !== key);
  return [...rest, fresh];
}

/** 删除账号；key 不存在则原样返回。 */
export function removeAccount(accounts: AccountMeta[], key: string): AccountMeta[] {
  return accounts.filter((a) => a.key !== key);
}

/** 不可变地为账号追加/覆盖一个系列映射。id 可选，未传则不写 id 字段。 */
export function mapSeries(
  account: AccountMeta,
  repoName: string,
  dir: string,
  id?: number
): AccountMeta {
  const entry: SeriesEntry = id === undefined ? { dir } : { dir, id };
  return { ...account, series: { ...account.series, [repoName]: entry } };
}

/** 不可变地删除一个系列映射。 */
export function unmapSeries(account: AccountMeta, repoName: string): AccountMeta {
  const next = { ...account.series };
  delete next[repoName];
  return { ...account, series: next };
}

/** 便捷取某系列的本地目录；不存在返回 undefined。 */
export function seriesDir(series: SeriesMap, repoName: string): string | undefined {
  return series[repoName]?.dir;
}

/** 便捷取某系列的后端 id；无 id 或不存在返回 undefined。 */
export function seriesId(account: AccountMeta, repoName: string): number | undefined {
  return account.series[repoName]?.id;
}

/**
 * 兼容迁移：旧结构系列值为裸 string（目录路径）→ 包裹为 { dir } 供新结构读取。
 * 对象值原样保留（浅拷贝）。旧的 string 值退化到缺-id 路径，之后由 ensureSeriesId 反查补 id。
 */
export function normalizeSeriesMap(series: Record<string, string | SeriesEntry>): SeriesMap {
  const out: SeriesMap = {};
  for (const [repo, v] of Object.entries(series)) {
    // repo 来自持久化/后端数据，`__proto__` 等键会走到 Object.prototype 的访问器上，
    // 结果是映射丢失并改写原型，故显式跳过。
    if (repo === "__proto__" || repo === "constructor" || repo === "prototype") continue;
    out[repo] = typeof v === "string" ? { dir: v } : { ...v };
  }
  return out;
}
