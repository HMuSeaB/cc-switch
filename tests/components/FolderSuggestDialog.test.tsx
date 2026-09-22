import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FolderSuggestDialog } from "@/components/providers/FolderSuggestDialog";
import type { FolderSuggestResult } from "@/lib/api/providers";

const getConfigMock = vi.fn();
const suggestMock = vi.fn();
const setProvidersFolderMock = vi.fn();
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
    setProvidersFolder: (...args: unknown[]) => setProvidersFolderMock(...args),
    setFolderSuggestConfig: (...args: unknown[]) => setConfigMock(...args),
  },
}));

// Radix Popover / Dialog 在 jsdom 下需要这两个 API
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

function result(
  suggestions: FolderSuggestResult["suggestions"],
  overrides?: Partial<FolderSuggestResult>,
): FolderSuggestResult {
  return {
    suggestions,
    source: "typesafe",
    degradedReason: null,
    usage: null,
    ...overrides,
  };
}

function renderDialog(appId = "claude") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <FolderSuggestDialog
      open={true}
      onOpenChange={() => {}}
      appId={appId as never}
    />,
    { wrapper },
  );
}

describe("FolderSuggestDialog", () => {
  beforeEach(() => {
    getConfigMock.mockResolvedValue({
      configured: true,
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
    });
    setProvidersFolderMock.mockResolvedValue(1);
  });

  it("shows the generate prompt before any suggestion exists", async () => {
    renderDialog();

    expect(await screen.findByText("生成建议")).toBeInTheDocument();
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("warns when TypeSafe is not configured", async () => {
    getConfigMock.mockResolvedValue({
      configured: false,
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
    });

    renderDialog();

    expect(
      await screen.findByText(/尚未配置 TypeSafe API Key/),
    ).toBeInTheDocument();
  });

  it("defaults to checking only high-confidence suggestions", async () => {
    suggestMock.mockResolvedValue(
      result([
        {
          providerId: "p1",
          providerName: "高置信供应商",
          suggestedFolder: "官方",
          confidence: 0.9,
          highConfidence: true,
          alternatives: [{ folder: "官方", probability: 0.9 }],
          source: "typesafe",
        },
        {
          providerId: "p2",
          providerName: "低置信供应商",
          suggestedFolder: "中转",
          confidence: 0.4,
          highConfidence: false,
          alternatives: [{ folder: "中转", probability: 0.4 }],
          source: "typesafe",
        },
      ]),
    );

    renderDialog();

    fireEvent.click(await screen.findByText("生成建议"));

    // 等高置信供应商出现，说明结果已渲染
    expect(await screen.findByText("高置信供应商")).toBeInTheDocument();

    const lowRow = screen.getByText("低置信供应商").closest("div.rounded-xl");
    expect(lowRow).not.toBeNull();
    const lowCheckbox = within(lowRow as HTMLElement).getByRole("checkbox");
    expect(lowCheckbox).toHaveAttribute("data-state", "unchecked");

    const highRow = screen.getByText("高置信供应商").closest("div.rounded-xl");
    const highCheckbox = within(highRow as HTMLElement).getByRole("checkbox");
    expect(highCheckbox).toHaveAttribute("data-state", "checked");
  });

  it("does not default-check a 'stay ungrouped' suggestion even at high confidence", async () => {
    suggestMock.mockResolvedValue(
      result([
        {
          providerId: "p1",
          providerName: "无家可归",
          suggestedFolder: null,
          confidence: 0.95,
          highConfidence: true,
          alternatives: [{ folder: null, probability: 0.95 }],
          source: "typesafe",
        },
      ]),
    );

    renderDialog();

    fireEvent.click(await screen.findByText("生成建议"));
    const row = (await screen.findByText("无家可归")).closest("div.rounded-xl");
    const checkbox = within(row as HTMLElement).getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("applies only the checked suggestions", async () => {
    suggestMock.mockResolvedValue(
      result([
        {
          providerId: "p1",
          providerName: "供应商A",
          suggestedFolder: "官方",
          confidence: 0.9,
          highConfidence: true,
          alternatives: [{ folder: "官方", probability: 0.9 }],
          source: "typesafe",
        },
        {
          providerId: "p2",
          providerName: "供应商B",
          suggestedFolder: "中转",
          confidence: 0.9,
          highConfidence: true,
          alternatives: [{ folder: "中转", probability: 0.9 }],
          source: "typesafe",
        },
      ]),
    );

    renderDialog();

    fireEvent.click(await screen.findByText("生成建议"));
    await screen.findByText("供应商A");

    // 取消供应商B
    const rowB = screen.getByText("供应商B").closest("div.rounded-xl");
    fireEvent.click(within(rowB as HTMLElement).getByRole("checkbox"));

    fireEvent.click(screen.getByText("应用所选"));

    await waitFor(() => expect(setProvidersFolderMock).toHaveBeenCalled());
    // 只该发一次调用，且只含 p1
    expect(setProvidersFolderMock).toHaveBeenCalledTimes(1);
    expect(setProvidersFolderMock).toHaveBeenCalledWith(
      ["p1"],
      "官方",
      "claude",
    );
  });

  it("lets the user override the target folder via the select", async () => {
    suggestMock.mockResolvedValue(
      result([
        {
          providerId: "p1",
          providerName: "可改判",
          suggestedFolder: "官方",
          confidence: 0.6,
          highConfidence: false,
          alternatives: [
            { folder: "官方", probability: 0.6 },
            { folder: "中转", probability: 0.3 },
          ],
          source: "typesafe",
        },
      ]),
    );

    renderDialog();

    fireEvent.click(await screen.findByText("生成建议"));
    await screen.findByText("可改判");

    const row = screen.getByText("可改判").closest("div.rounded-xl");
    const select = within(row as HTMLElement).getByRole("combobox");
    fireEvent.change(select, { target: { value: "中转" } });

    // 勾选后用改判后的文件夹应用
    fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
    fireEvent.click(screen.getByText("应用所选"));

    await waitFor(() => expect(setProvidersFolderMock).toHaveBeenCalled());
    expect(setProvidersFolderMock).toHaveBeenCalledWith(
      ["p1"],
      "中转",
      "claude",
    );
  });

  it("explains why it degraded to the heuristic path", async () => {
    suggestMock.mockResolvedValue(
      result([], {
        source: "heuristic",
        degradedReason: "TypeSafe 调用失败，已使用本地启发式",
      }),
    );

    renderDialog();

    fireEvent.click(await screen.findByText("生成建议"));
    expect(
      await screen.findByText("TypeSafe 调用失败，已使用本地启发式"),
    ).toBeInTheDocument();
  });
});
