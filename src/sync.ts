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
    if (fp === d || fp.startsWith(d.endsWith("/") ? d : d + "/")) {
      if (!best || d.length > best.len) best = { dir: entry.dir, len: d.length };
    }
  }
  return best ? best.dir : null;
}

/** 该账号所有映射目录（原始值，去重）。 */
export function collectPullTargets(account: AccountMeta): string[] {
  return Array.from(new Set(Object.values(account.series).map((s) => s.dir)));
}
