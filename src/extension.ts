import * as vscode from "vscode";
import { registerCommands, getCurrentAccountFromState, MANAGE_SERIES_VIEW } from "./commands";
import { startAutoSync } from "./auto-sync";

/** 扩展激活入口：以真实实现注册命令与树视图，并启动自动同步。 */
export function activate(context: vscode.ExtensionContext): void {
  // 账号持久化交给 registerCommands 内部闭包；此处注册 provider 与命令。
  const provider = registerCommands(context, vscode.commands.registerCommand.bind(vscode.commands));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(MANAGE_SERIES_VIEW, provider),
    // provider 持有 EventEmitter，随扩展停用一起 dispose，避免重建时泄漏监听。
    provider
  );
  // 注册自动同步副作用，随停用一起清理。
  context.subscriptions.push(startAutoSync(() => getCurrentAccountFromState(context)));
}

/** 扩展停用入口：无需清理。 */
export function deactivate(): void {
  // 无清理逻辑。
}
