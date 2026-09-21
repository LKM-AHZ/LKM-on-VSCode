import { AccountMeta } from "./accounts";

export interface SyncSettings {
  pullIntervalMinutes: number;
  pullOnFocus: boolean;
  autoPushEnabled: boolean;
}

/** 归一化路径为小写正斜杠，便于跨平台前缀比较。 */
function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 判断到点该 pull：从未跑(null)或距上次已超 interval(分钟)。 */
export function shouldPullNow(
  lastRunAt: number | null,
  intervalMinutes: number,
  now: number
): boolean {
  if (intervalMinutes <= 0) return false;
  if (lastRunAt === null) return true;
  // 上次记录晚于当前时间（系统时钟回拨，或记录来自时钟更快的机器）时差值为负，
  // 会一直判为「未到点」而彻底停掉定时拉取；此时按已过期处理。
  if (lastRunAt > now) return true;
  return now - lastRunAt >= intervalMinutes * 60 * 1000;
}

/**
 * 判断一个文件路径是否属于某账号的某个映射系列目录。
 * 命中返回该系列映射目录（原始大小写），最长匹配优先，目录边界匹配；否则 null。
 */
export function pathBelongsToAccount(filePath: string, account: AccountMeta): string | null {
  const fp = norm(filePath);
  let best: { dir: string; len: number } | null = null;
  for (const entry of Object.values(account.series)) {
    const d = norm(entry.dir);
    // 空/根目录会退化成前缀 "/" 从而匹配任意绝对路径（错误归属+定位到错误目录），直接跳过。
    if (!d || d === "/") continue;
    if (fp === d || fp.startsWith(d.endsWith("/") ? d : d + "/")) {
      if (!best || d.length > best.len) best = { dir: entry.dir, len: d.length };
    }
  }
  return best ? best.dir : null;
}

/** 该账号所有映射目录（原始值，去重）。 */
export function collectPullTargets(account: AccountMeta): string[] {
  // 去重口径必须与 pathBelongsToAccount 一致（按 norm 归一化），否则
  // "C:/x/a" 与 "c:\x\a" 会被判为同一目录却重复 pull 同一仓库。
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of Object.values(account.series)) {
    const key = norm(s.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.dir);
  }
  return out;
}
