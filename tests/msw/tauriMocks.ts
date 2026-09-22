import "cross-fetch/polyfill";
import { vi } from "vitest";
import { server } from "./server";

const TAURI_ENDPOINT = "http://tauri.local";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch(`${TAURI_ENDPOINT}/${command}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload ?? {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Invoke failed for ${command}`);
    }

    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },
}));

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

const ensureListenerSet = (event: string) => {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  return listeners.get(event)!;
};

/**
 * 清空所有已注册的事件监听器。
 *
 * `listeners` 是模块级 Map，`listen()` 只往里加、RTL 的 cleanup 不会碰它。
 * 而 `listen()` 返回的 unlisten 回调只有在组件 useEffect 的 cleanup 真的跑到时
 * 才会执行——测试里组件被卸载时 React 确实会跑 cleanup，但只要有一个测试
 * 中途失败/超时，后续测试就会叠加到上一轮残留的 handler 上。
 *
 * 后果不是"多收一次事件"这么轻：残留的 handler 持有上一个（已卸载）App 实例的
 * 闭包，会继续往那个实例的 setState 上写，表现为 toast 重复弹出、
 * `waitFor` 等不到预期状态而超时。所以在全局 afterEach 里显式清空，
 * 与 `resetProviderState()` 同一套思路。
 */
export const resetTauriListeners = () => {
  listeners.clear();
};

export const emitTauriEvent = (event: string, payload: unknown) => {
  const handlers = listeners.get(event);
  // 拷贝一份再遍历：handler 内部可能触发 React 重渲染，进而同步跑到
  // useEffect cleanup 去 delete 自己，原地遍历会跳过后续 handler。
  handlers?.forEach((handler) => handler({ payload }));
};

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    const set = ensureListenerSet(event);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  },
}));

/**
 * `@tauri-apps/api/window` 的 mock。
 *
 * 不 mock 它的话，`getCurrentWindow()` 会在真实实现里读
 * `window.__TAURI_INTERNALS__.metadata` —— jsdom 下这个对象不存在，直接抛
 * "Cannot read properties of undefined (reading 'metadata')"。App.tsx 在
 * useEffect 里调用它来同步窗口装饰/最大化状态，异常会冒到渲染流程里，
 * 让整个 provider 视图渲染不出来，测试只能干等到超时。
 *
 * 这里提供一个最小可用的假 Window：只实现 App.tsx 实际用到的那几个方法。
 */
vi.mock("@tauri-apps/api/window", () => {
  const noop = async () => {};
  const currentWindow = {
    label: "main",
    minimize: noop,
    maximize: noop,
    unmaximize: noop,
    close: noop,
    show: noop,
    hide: noop,
    setDecorations: noop,
    setFocus: noop,
    isMaximized: async () => false,
    isMinimized: async () => false,
    isVisible: async () => true,
    listen: async () => () => {},
    once: async () => () => {},
    onResized: async () => () => {},
    onMoved: async () => () => {},
    onFocusChanged: async () => () => {},
    onScaleChanged: async () => () => {},
    onCloseRequested: async () => () => {},
    onDragDropEvent: async () => () => {},
    onThemeChanged: async () => () => {},
    emit: async () => {},
    scaleFactor: async () => 1,
    innerSize: async () => ({ width: 1280, height: 800 }),
    outerPosition: async () => ({ x: 0, y: 0 }),
  };
  const getCurrentWindow = () => currentWindow;

  return {
    getCurrentWindow,
    getAllWindows: async () => [currentWindow],
    LogicalSize: class {
      constructor(
        public width: number,
        public height: number,
      ) {}
    },
    LogicalPosition: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
    PhysicalSize: class {
      constructor(
        public width: number,
        public height: number,
      ) {}
    },
    PhysicalPosition: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
  };
});

// Ensure the MSW server is referenced so tree shaking doesn't remove imports
void server;

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/mock",
  join: async (...segments: string[]) => segments.join("/"),
}));
