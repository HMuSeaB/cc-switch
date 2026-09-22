import type { ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFolderSuggest } from "@/hooks/useFolderSuggest";

const getConfigMock = vi.fn();
const suggestMock = vi.fn();
const setProvidersFolderEnsureMock = vi.fn();
const setConfigMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getFolderSuggestConfig: (...args: unknown[]) => getConfigMock(...args),
    suggestProviderFolders: (...args: unknown[]) => suggestMock(...args),
    setProvidersFolderEnsure: (...args: unknown[]) => setProvidersFolderEnsureMock(...args),
    setFolderSuggestConfig: (...args: unknown[]) => setConfigMock(...args),
  },
}));

// i18n 在测试环境被初始化成空资源表，t() 会回退到 key 本身。
// 这里模拟真实插值行为：把 defaultValue 里的 {{count}} 等替换掉，
// 否则断言 toast 文案时要手写未插值的模板。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown>) => {
      let text = (opts?.defaultValue as string) ?? _key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (k === "defaultValue") continue;
        // 用 split/join 而非 replaceAll：项目 tsconfig 的 lib 还没到 es2021
        text = text.split(`{{${k}}}`).join(String(v));
      }
      return text;
    },
  }),
}));

interface WrapperProps {
  children: ReactNode;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: WrapperProps) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

describe("useFolderSuggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue({
      configured: true,
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
    });
    suggestMock.mockResolvedValue({
      suggestions: [],
      source: "typesafe",
      degradedReason: null,
      usage: null,
    });
    setProvidersFolderEnsureMock.mockResolvedValue(1);
    setConfigMock.mockResolvedValue(true);
  });

  it("reports whether TypeSafe is configured", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));
    expect(getConfigMock).toHaveBeenCalled();
  });

  it("groups assignments by folder before issuing batch calls", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.applySuggestions.mutateAsync([
        { providerId: "p1", folder: "官方" },
        { providerId: "p2", folder: "官方" },
        { providerId: "p3", folder: "中转" },
        { providerId: "p4", folder: null },
      ]);
    });

    // 4 条决定应合并成 3 次批量调用（两个"官方"合成一次）
    expect(setProvidersFolderEnsureMock).toHaveBeenCalledTimes(3);
    expect(setProvidersFolderEnsureMock).toHaveBeenCalledWith(
      ["p1", "p2"],
      "官方",
      "claude",
    );
    expect(setProvidersFolderEnsureMock).toHaveBeenCalledWith(
      ["p3"],
      "中转",
      "claude",
    );
    // 未分组也要发一次：用户可能把原本有分组的供应商改回未分组
    expect(setProvidersFolderEnsureMock).toHaveBeenCalledWith(["p4"], null, "claude");

    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("reports the total number of providers moved", async () => {
    setProvidersFolderEnsureMock.mockResolvedValue(5);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.applySuggestions.mutateAsync([
        { providerId: "p1", folder: "官方" },
      ]);
    });

    expect(toastSuccessMock).toHaveBeenCalledWith("已应用 5 个供应商的分组");
  });

  it("surfaces apply failures as a toast", async () => {
    setProvidersFolderEnsureMock.mockRejectedValue(new Error("数据库写入失败"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.applySuggestions
        .mutateAsync([{ providerId: "p1", folder: "官方" }])
        .catch(() => undefined);
    });

    expect(toastErrorMock).toHaveBeenCalledWith("数据库写入失败");
  });

  it("passes the appId through when requesting suggestions", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("codex"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.suggest.mutateAsync();
    });

    expect(suggestMock).toHaveBeenCalledWith("codex");
  });

  it("shows an error toast when suggestion generation fails", async () => {
    suggestMock.mockRejectedValue(new Error("TypeSafe 超时"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.suggest.mutateAsync().catch(() => undefined);
    });

    expect(toastErrorMock).toHaveBeenCalledWith("TypeSafe 超时");
  });

  it("saves config with the clearApiKey flag", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFolderSuggest("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.configured).toBe(true));

    await act(async () => {
      await result.current.saveConfig.mutateAsync({ clearApiKey: true });
    });

    expect(setConfigMock).toHaveBeenCalledWith({ clearApiKey: true });
  });
});
