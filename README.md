# LKM-on-VSCode

在 VS Code 中克隆并编辑 LKM 平台的 blog 系列（Git 托管博客）。

> 当前版本为 `0.0.1`。默认自动同步仅执行 pull；自动提交/推送需显式开启。项目总文档见
> [`../DOCUMENTATION.md`](../DOCUMENTATION.md)。

## 环境要求

- Node.js 20 或更高版本
- pnpm
- VS Code `^1.85.0`
- 系统可用的 Git 命令行

## 安装

```sh
pnpm install
pnpm run compile
pnpm test
pnpm run package
```

在 VS Code 扩展面板选择“从 VSIX 安装”，打开生成的 `lkm-on-vscode-0.0.1.vsix`。

## 多账号
支持管理多个 LKM 账号，每个账号独立缓存凭证与系列映射：
- `LKM: Add Account`：添加账号（输入后端地址与用户名密码，密码存入 SecretStorage）。
- `LKM: Switch Account`：切换当前账号。
- `LKM: Remove Account`：删除账号并清除其凭证与系列映射。

## 管理面板（TreeView）
侧栏 Activity Bar 新增 **LKM Series** 面板，展示当前账号克隆到本地的系列，支持后续在面板内 CRUD。

## 使用
1. 设置 `lkm.serverUrl`（LKM 后端地址）。
2. `LKM: Add Account` 后 `LKM: Clone Blog`，选择系列与本地目录。
3. 编辑后 `LKM: Push` 推送；收到远端改动用 `LKM: Pull` 拉取。

## 系列 CRUD
- 创建系列：`LKM: Create Series`（Bearer 认证，成功后映射到当前账号）。
- 删除系列：`LKM: Delete Series` —— 调 `DELETE /blog/series/{id}`，成功后移除本地映射。系列 id 在 clone 时写入映射；旧映射缺失时会在首次操作按 repo_name 反查并自动补写。
- 星标：`LKM: Toggle Star` —— 调 `POST /blog/series/{id}/star`，按返回 `starred` 反馈加星/取消星。

## 自动同步
默认**只读**：按账号映射目录执行 pull（定时轮询 + 窗口聚焦时触发），失败静默时不打断编辑。

- 定时拉取：`lkm.sync.pullIntervalMinutes`（默认 5 分钟）。
- 聚焦拉取：`lkm.sync.pullOnFocus`（默认 true）。
- 自动保存推送：`lkm.autoPush.enabled`（默认 **false**）。开启后，保存已映射系列中的文件时，只暂存并提交这个文件，再推送当前仓库。暂存区已有改动时会中止并提示，避免提交其他文件。无 Git 改动的保存不会产生提交。

**已知限制（自动 pull 仅对已打开仓库生效）**：定时/聚焦 pull 通过 GitExtension 按目录解析仓库，只认**当前已在该 VS Code 工作区打开/加载**的仓库。被映射到某目录、但当前未打开的仓库**不会**被自动拉取（静默跳过，属预期行为）。如需同步此类未打开目录，请显式 `LKM: Pull` 或将该目录加入工作区后等待下一次自动拉取。

自动推送同样要求仓库已在 VS Code 中打开。推送失败时本地提交会保留，可在处理网络或远端冲突后手动重试 `LKM: Push`。

## 配置
- `lkm.serverUrl`：LKM 后端地址，如 `https://lkm-ahz.ltd`。
- `lkm.sync.pullIntervalMinutes` / `lkm.sync.pullOnFocus` / `lkm.autoPush.enabled`：自动同步参数（见上）。

## 凭证
用户名与密码存入 VS Code 安全存储（SecretStorage），clone 时内联于 git URL，首次推送可能提示保存 git 凭证。克隆使用系统 Git 命令行，成功后记录实际仓库目录供自动同步使用。每次 API 操作复用缓存的 Bearer token；遇 401 会自动使缓存失效并在下次操作重新登录兑换（规避登录限流）。

不要把包含凭证的 Git remote URL、VS Code 用户数据目录或调试日志提交到仓库。移除账号会清理
扩展保存的 SecretStorage 记录，但不会自动删除系统 Git 凭证管理器中可能保存的凭证。

## 开发与验证

```sh
pnpm run compile
pnpm test
```

在 VS Code 中按 `F5` 启动 Extension Development Host，至少验证添加/切换账号、克隆、显式 pull、
显式 push 和 TreeView 刷新。涉及网络协议的改动应同时核对后端 `/api/v1/blog` 与 `/blog/git` 行为。
