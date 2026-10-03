/**
 * 测试桩：vscode 模块的 mock。
 *
 * 背景：业务模块顶层会 `import * as vscode from "vscode"`，
 * 而 `@types/vscode` 只是类型，node 运行时并不存在该模块。
 * vitest.config.ts 通过 resolve.alias 把 `vscode` 指到这里，
 * 使单测能在 node 环境下 import 这些模块而不崩。
 *
 * 只提供可调用的 stub / 空对象，语义逻辑由各测试自行 mock。
 */

/**
 * 内存版配置存储：按 section → key 分层，update() 写入后能被后续 getConfiguration().get() 读到，
 * 否则依赖配置的代码永远只看到默认值，读/写流程从未被真正走到。
 */
const configStore = new Map<string, Map<string, unknown>>();
const saveListeners = new Set<(document: unknown) => void>();
const focusListeners = new Set<(state: { focused: boolean }) => void>();

export function __emitDidSave(document: unknown): void {
  for (const listener of saveListeners) listener(document);
}

export const workspace = {
  getConfiguration: (section = "") => {
    let values = configStore.get(section);
    if (!values) {
      values = new Map<string, unknown>();
      configStore.set(section, values);
    }
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        values.has(key) ? (values.get(key) as T) : defaultValue,
      has: (key: string) => values.has(key),
      inspect: () => undefined,
      update: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
  },
  workspaceFolders: [],
  onDidSaveTextDocument: (listener: (document: unknown) => void) => {
    saveListeners.add(listener);
    return { dispose: () => saveListeners.delete(listener) };
  },
};

/**
 * 可控制输入的 showInputBox 桩。
 *
 * 测试可在用例内替换 `__inputBoxQueue` 数组来控制每次调用的返回值
 * （空数组表示无输入 → 返回 undefined）。它是模块级的可注入控制点，
 * 不要求配合 vi.mock，直接通过本模块导入使用即可。
 */
export const __inputBoxQueue: Array<string | undefined> = [];

/**
 * 清空输入队列。
 * 队列是模块级共享状态：未消费完的条目会漏进下一个用例造成顺序相关的偶发失败，
 * 用例的 beforeEach 里统一调用它复位。
 */
export const resetInputBoxQueue = (): void => {
  __inputBoxQueue.length = 0;
};

export const window = {
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => {
    const value = __inputBoxQueue.shift();
    return Promise.resolve(value);
  },
  createOutputChannel: (_name?: string) => ({
    append: () => {},
    appendLine: () => {},
    show: () => {},
  }),
  showOpenDialog: () => Promise.resolve(undefined),
  showSaveDialog: () => Promise.resolve(undefined),
  onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => {
    focusListeners.add(listener);
    return { dispose: () => focusListeners.delete(listener) };
  },
};

export const extensions = {
  getExtension: () => undefined,
  all: [],
};

export const commands = {
  registerCommand: (_command: string, _callback: (...args: never[]) => unknown) => ({
    dispose: () => {},
  }),
  registerTextEditorCommand: (_command: string, _callback: (...args: never[]) => unknown) => ({
    dispose: () => {},
  }),
  executeCommand: () => Promise.resolve(undefined),
};

export const env = {
  language: "en",
  machineId: "",
  uiKind: 1,
};

/**
 * 最小 Uri 桩：除 parse/file 外补齐 path/authority/query/fragment 与 with/joinPath/toString(true)，
 * 否则用 joinPath/with 拼路径的代码在被测时会抛错或静默走错分支。
 */
function makeUri(value: string) {
  return {
    scheme: "file",
    fsPath: value,
    path: value,
    authority: "",
    query: "",
    fragment: "",
    with: (change: { path?: string; fsPath?: string; scheme?: string }) =>
      makeUri(change.path ?? change.fsPath ?? value),
    joinPath: (segment: string) => makeUri(`${value.replace(/\/+$/, "")}/${segment}`),
    toString: (_skipEncoding?: boolean) => value,
  };
}

export const Uri = {
  parse: (value: string) => makeUri(value),
  file: (path: string) => makeUri(path),
};

export const Disposable = class Disposable {
  constructor(private readonly callback?: () => void) {}
  dispose(): void { this.callback?.(); }
};

/** TreeItem 的三种折叠状态枚举（与 vscode 真实取值一致：0/1/2）。 */
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

/**
 * TreeItem 最小实现：仅满足树节点的构造/字段写入，
 * description/contextValue/id 等字段为可写属性，便于测试断言。
 */
export const TreeItem = class TreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  contextValue?: string;
  id?: string;
  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
};

export const EventEmitter = class EventEmitter<T = unknown> {
  private listeners: Array<(e: T) => unknown> = [];
  // 真实 EventEmitter 的 event() 会登记监听者；只返回 Disposable 而不登记，
  // 会让 fire() 永远没人收到，事件驱动逻辑在测试里变成假绿灯。
  event = (listener: (e: T) => unknown, _thisArgs?: unknown, _disposables?: unknown) => {
    this.listeners.push(listener);
    return new Disposable();
  };
  fire(data?: T): void {
    for (const listener of this.listeners) listener(data as T);
  }
  dispose(): void {
    this.listeners = [];
  }
};

/**
 * 内存版 Memento 桩：还原 get/update/keys 语义。
 * 用 {} 顶替会让持久化代码在 `state.get is not a function` 上抛错或被静默跳过，
 * 状态读写路径就从未被真正测到。
 */
export function createMementoStub(): {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
} {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    keys: () => Array.from(store.keys()),
  };
}

const extensionContext: Record<string, unknown> = {
  subscriptions: [],
  extensionPath: "",
  extensionUri: Uri.file(""),
  workspaceState: createMementoStub(),
  globalState: createMementoStub(),
  secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
};

export const ExtensionContext = extensionContext;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
