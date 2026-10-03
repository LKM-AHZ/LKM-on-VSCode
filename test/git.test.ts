import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepository, embedBasicAuth, getGitByDir } from "../src/git";

describe("git", () => {
  it("embedBasicAuth 把 user:pass 内联进 clone URL 的 host 前", () => {
    const url = embedBasicAuth("https://host/api/v1/blog/git/my-blog.git", "al", "pw");
    // 内联成 https://al:pw@host/api...
    expect(url.startsWith("https://al:pw@host/")).toBe(true);
    expect(url.endsWith("/api/v1/blog/git/my-blog.git")).toBe(true);
  });

  it("embedBasicAuth 对 URL 中 userinfo 做 encodeURIComponent", () => {
    const url = embedBasicAuth("https://h/g.git", "user name", "p@ss");
    expect(url).toContain("@h/");
    expect(url.startsWith("https://user%20name:p%40ss@h/g.git")).toBe(true);
  });

  it("克隆后返回实际仓库目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "lkm-vscode-git-"));
    try {
      const remote = join(root, "remote.git");
      const parent = join(root, "workspace");
      mkdirSync(parent);
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      const cloned = await cloneRepository(remote, parent, "my-blog");
      expect(cloned).toBe(join(parent, "my-blog"));
      expect(existsSync(join(cloned, ".git"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝把仓库名当路径穿越目标目录", async () => {
    await expect(cloneRepository("https://host/repo.git", "/tmp", "../elsewhere")).rejects.toThrow("无效的仓库目录名");
  });
});

describe("git.getGitByDir", () => {
  it("按 rootUri 归一化匹配仓库", async () => {
    const repo = {
      rootUri: { fsPath: "C:\\x\\a-blog" },
      pull: vi.fn(), push: vi.fn(), status: vi.fn(), add: vi.fn(), commit: vi.fn(),
      state: { indexChanges: [], workingTreeChanges: [{ uri: { fsPath: "C:/x/a-blog/post.md" } }] },
    };
    const api = { repositories: [repo] };
    (vscode.extensions as any).getExtension = () => ({ activate: async () => ({ getAPI: () => api }) });
    const r = await getGitByDir("C:/x/a-blog");
    expect(r).not.toBeNull();
    await r!.pull();
    await r!.push();
    expect(repo.pull).toHaveBeenCalledOnce();
    expect(repo.push).toHaveBeenCalledOnce();
    expect(await r!.commitSavedFile("C:/x/a-blog/post.md")).toBe(true);
    expect(repo.add).toHaveBeenCalledWith(["C:/x/a-blog/post.md"]);
    expect(repo.commit).toHaveBeenCalledWith("lkm: auto-sync", { all: false, postCommitCommand: null });
  });

  it("找不到返回 null", async () => {
    (vscode.extensions as any).getExtension = () => ({ activate: async () => ({ getAPI: () => ({ repositories: [] }) }) });
    expect(await getGitByDir("C:/nope")).toBeNull();
  });

  it("暂存区有改动时不自动提交其他文件", async () => {
    const repo = {
      rootUri: { fsPath: "/work/blog" }, pull: vi.fn(), push: vi.fn(), status: vi.fn(),
      add: vi.fn(), commit: vi.fn(),
      state: { indexChanges: [{ uri: { fsPath: "/work/blog/other.md" } }], workingTreeChanges: [{ uri: { fsPath: "/work/blog/post.md" } }] },
    };
    (vscode.extensions as any).getExtension = () => ({ activate: async () => ({ getAPI: () => ({ repositories: [repo] }) }) });
    const git = await getGitByDir("/work/blog");
    await expect(git!.commitSavedFile("/work/blog/post.md")).rejects.toThrow("暂存区已有改动");
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("保存文件在 Git 中无改动时不提交", async () => {
    const repo = {
      rootUri: { fsPath: "/work/blog" }, pull: vi.fn(), push: vi.fn(), status: vi.fn(),
      add: vi.fn(), commit: vi.fn(),
      state: { indexChanges: [], workingTreeChanges: [] },
    };
    (vscode.extensions as any).getExtension = () => ({ activate: async () => ({ getAPI: () => ({ repositories: [repo] }) }) });
    const git = await getGitByDir("/work/blog");
    expect(await git!.commitSavedFile("/work/blog/post.md")).toBe(false);
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.commit).not.toHaveBeenCalled();
  });
});
