import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderManageDialog } from "@/components/providers/FolderManageDialog";

describe("FolderManageDialog", () => {
  it("renders create mode and validates input", async () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <FolderManageDialog
        open={true}
        onOpenChange={onOpenChange}
        mode="create"
        existingFolders={["官方", "中转"]}
        onSave={onSave}
      />,
    );

    const submitButton = screen.getByRole("button", { name: /创建|common\.create/ });
    fireEvent.click(submitButton);
    expect(onSave).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "官方" } });
    fireEvent.click(submitButton);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "新分组" } });
    fireEvent.click(submitButton);
    expect(onSave).toHaveBeenCalledWith("新分组");
  });

  it("renders rename mode with initial name", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <FolderManageDialog
        open={true}
        onOpenChange={onOpenChange}
        mode="rename"
        initialName="旧名称"
        existingFolders={["官方", "旧名称"]}
        onSave={onSave}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("旧名称");

    fireEvent.change(input, { target: { value: "更新名称" } });
    const saveButton = screen.getByRole("button", { name: /保存|common\.save/ });
    fireEvent.click(saveButton);
    expect(onSave).toHaveBeenCalledWith("更新名称");
  });
});