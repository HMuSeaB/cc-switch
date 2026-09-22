import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderFolderCard } from "@/components/providers/ProviderFolderCard";

describe("ProviderFolderCard", () => {
  it("renders folder name, node count, and children", () => {
    render(
      <ProviderFolderCard
        name="测试文件夹"
        count={3}
        isCustomFolder={true}
      >
        <div data-testid="child-node">节点内容</div>
      </ProviderFolderCard>,
    );

    expect(screen.getByText("测试文件夹")).toBeInTheDocument();
    expect(screen.getByText("3 节点")).toBeInTheDocument();
    expect(screen.getByTestId("child-node")).toBeInTheDocument();
  });

  it("toggles collapse and expand when header is clicked", () => {
    render(
      <ProviderFolderCard
        name="测试折叠"
        count={1}
        defaultExpanded={true}
      >
        <div data-testid="child-node">可折叠内容</div>
      </ProviderFolderCard>,
    );

    const headerButton = screen.getByText("测试折叠");
    fireEvent.click(headerButton);
    fireEvent.click(headerButton);
    expect(screen.getByTestId("child-node")).toBeInTheDocument();
  });
});