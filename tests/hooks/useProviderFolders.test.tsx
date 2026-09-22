import type { ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderFolder } from "@/types";
import { useProviderFolders } from "@/hooks/useProviderFolders";

const getFoldersMock = vi.fn();
const createFolderMock = vi.fn();
const renameFolderMock = vi.fn();
const deleteFolderMock = vi.fn();
const setProvidersFolderMock = vi.fn();
const saveFoldersOrderMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    getFolders: (...args: unknown[]) => getFoldersMock(...args),
    createFolder: (...args: unknown[]) => createFolderMock(...args),
    renameFolder: (...args: unknown[]) => renameFolderMock(...args),
    deleteFolder: (...args: unknown[]) => deleteFolderMock(...args),
    setProvidersFolder: (...args: unknown[]) => setProvidersFolderMock(...args),
    saveFoldersOrder: (...args: unknown[]) => saveFoldersOrderMock(...args),
  },
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

const folders: ProviderFolder[] = [
  { id: "folder_0", name: "主力官方", sortIndex: 0, isExpanded: true },
  { id: "folder_1", name: "国内中转", sortIndex: 1, isExpanded: true },
];

describe("useProviderFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getFoldersMock.mockResolvedValue(folders);
    createFolderMock.mockResolvedValue(folders);
    renameFolderMock.mockResolvedValue(3);
    deleteFolderMock.mockResolvedValue(2);
    setProvidersFolderMock.mockResolvedValue(1);
    saveFoldersOrderMock.mockResolvedValue(true);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("loads folders and exposes their names", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getFoldersMock).toHaveBeenCalledWith("claude");
    expect(result.current.folderNames).toEqual(["主力官方", "国内中转"]);
  });

  it("creates a folder and invalidates the query", async () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.createFolder.mutateAsync("新分组");
    });

    expect(createFolderMock).toHaveBeenCalledWith("新分组", "claude");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providerFolders", "claude"],
    });
  });

  it("renames a folder and refreshes providers too", async () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.renameFolder.mutateAsync({
        oldName: "主力官方",
        newName: "主力",
      });
    });

    expect(renameFolderMock).toHaveBeenCalledWith("主力官方", "主力", "claude");
    // 改名会动供应商的 folder 字段，两个 key 都要刷新
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providers", "claude"],
    });
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("reports how many providers moved when a folder is disbanded", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteFolder.mutate("国内中转");
    });

    expect(deleteFolderMock).toHaveBeenCalledWith("国内中转", "claude");
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "已解散文件夹，2 个供应商移到未分组",
    );
  });

  it("shows a plain toast when the disbanded folder was empty", async () => {
    deleteFolderMock.mockResolvedValue(0);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteFolder.mutate("空文件夹");
    });

    expect(toastSuccessMock).toHaveBeenCalledWith("已解散文件夹");
  });

  it("surfaces rename errors as a toast", async () => {
    renameFolderMock.mockRejectedValue(new Error("该文件夹已存在"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProviderFolders("claude"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // mutateAsync 的 rejection 会被 react-query 的 onError 接住并弹 toast，
    // 所以这里 await 它不会抛。用 await expect(...).rejects 反而会被吞掉，
    // 直接 await 后断言 toast 更稳妥。
    await act(async () => {
      await result.current.renameFolder
        .mutateAsync({ oldName: "a", newName: "b" })
        .catch(() => undefined);
    });

    expect(toastErrorMock).toHaveBeenCalledWith("该文件夹已存在");
  });

  describe("localStorage migration", () => {
    it("migrates legacy folders when the registry is empty", async () => {
      localStorage.setItem(
        "cc-switch:custom-folders",
        JSON.stringify(["旧分组A", "旧分组B", "  ", "旧分组A"]),
      );
      getFoldersMock.mockResolvedValue([]);

      const { wrapper } = createWrapper();
      renderHook(() => useProviderFolders("claude"), { wrapper });

      await waitFor(() => expect(createFolderMock).toHaveBeenCalled());

      // 去重 + 过滤空白项后只该建两个
      const calls = createFolderMock.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(["旧分组A", "旧分组B"]);

      // 迁移后旧 key 必须清掉，否则下次空注册表会反复重试
      await waitFor(() =>
        expect(
          localStorage.getItem("cc-switch:custom-folders"),
        ).toBeNull(),
      );
    });

    it("does not migrate when the registry already has folders", async () => {
      localStorage.setItem(
        "cc-switch:custom-folders",
        JSON.stringify(["旧分组"]),
      );

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useProviderFolders("claude"), {
        wrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      // 给 effect 一次机会跑，确认它没有触发创建
      await waitFor(() =>
        expect(localStorage.getItem("cc-switch:custom-folders")).toBeNull(),
      );
      expect(createFolderMock).not.toHaveBeenCalled();
      // 注册表已有数据 → 不该弹迁移成功的 toast
      expect(toastSuccessMock).not.toHaveBeenCalledWith(
        expect.stringContaining("已迁移"),
      );
    });

    it("does not migrate when there is no legacy data", async () => {
      getFoldersMock.mockResolvedValue([]);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useProviderFolders("claude"), {
        wrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      // 等 effect 跑完再断言
      await waitFor(() => expect(result.current.folderNames).toEqual([]));
      expect(createFolderMock).not.toHaveBeenCalled();
    });
  });
});
