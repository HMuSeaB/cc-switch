import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FolderCombobox } from "@/components/providers/forms/FolderCombobox";

// combobox 进 mor 的 Popover/Command 依赖 ResizeObserver + matchMedia，
// setupGlobals 已兜 ResizeObserver，这里补 matchMedia 与 scrollIntoView
// （jsdom 没实现后者，cmdk 选中项时会调）。
beforeAll(() => {
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
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const existing = ["主力官方", "国内中转", "DeepSeek"];

describe("FolderCombobox", () => {
  it("shows the current folder name", () => {
    render(
      <FolderCombobox
        value="国内中转"
        existingFolders={existing}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("国内中转")).toBeInTheDocument();
  });

  it("falls back to the ungrouped label when empty", () => {
    render(
      <FolderCombobox value="" existingFolders={existing} onChange={() => {}} />,
    );
    expect(screen.getByText("未分组")).toBeInTheDocument();
  });

  it("lists existing folders with their counts when opened", async () => {
    render(
      <FolderCombobox
        value=""
        existingFolders={existing}
        folderCounts={{ "主力官方": 3, "国内中转": 2 }}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText("主力官方")).toBeInTheDocument();
    });
    expect(screen.getByText("国内中转")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    // 数量展示成「· N」
    expect(screen.getByText("· 3")).toBeInTheDocument();
  });

  it("emits the picked folder name", async () => {
    const onChange = vi.fn();
    render(
      <FolderCombobox
        value=""
        existingFolders={existing}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByText("DeepSeek");
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith("DeepSeek");
  });

  it("offers to create a folder whose name does not exist yet", async () => {
    const onChange = vi.fn();
    render(
      <FolderCombobox
        value=""
        existingFolders={existing}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    const input = await screen.findByPlaceholderText("搜索或输入新文件夹名...");
    fireEvent.change(input, { target: { value: "全新分组" } });

    const createOption = await screen.findByText("新建文件夹「全新分组」");
    fireEvent.click(createOption);
    expect(onChange).toHaveBeenCalledWith("全新分组");
  });

  it("does not offer creation when the typed name already exists", async () => {
    render(
      <FolderCombobox
        value=""
        existingFolders={existing}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    const input = await screen.findByPlaceholderText("搜索或输入新文件夹名...");
    fireEvent.change(input, { target: { value: "DeepSeek" } });

    await waitFor(() => {
      expect(screen.queryByText(/新建文件夹/)).not.toBeInTheDocument();
    });
    // 已存在的那个仍然可见，方便直接选中
    expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
  });

  it("can clear the folder via the X button", () => {
    const onChange = vi.fn();
    render(
      <FolderCombobox
        value="国内中转"
        existingFolders={existing}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText("清除文件夹"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
