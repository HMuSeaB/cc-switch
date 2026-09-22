import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderCombobox } from "./FolderCombobox";
import { useProviderFolders } from "@/hooks/useProviderFolders";
import { providersApi, type AppId } from "@/lib/api";

interface FolderFormFieldProps {
  appId: AppId;
  value: string;
  onChange: (value: string) => void;
}

/**
 * 供应商表单里的文件夹选择字段。
 *
 * 单独拆一层而不是塞进 BasicFormFields：它依赖 react-query（读文件夹注册表
 * 和供应商列表），而 BasicFormFields 被 ClaudeDesktop / GrokBuild 等表单复用，
 * 那些场景的测试环境没有 QueryClientProvider。把查询依赖收在这里，调用方
 * 就能按需决定要不要渲染 combobox（不传 appId 时退回纯文本 Input）。
 */
export function FolderFormField({
  appId,
  value,
  onChange,
}: FolderFormFieldProps) {
  const { folderNames } = useProviderFolders(appId);

  const { data: allProviders } = useQuery({
    queryKey: ["providers", appId],
    queryFn: () => providersApi.getAll(appId),
    staleTime: 30_000,
  });

  // 每个文件夹下已有多少供应商，展示成「名字 · N」帮用户判断该放哪
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!allProviders) return counts;
    for (const provider of Object.values(allProviders)) {
      const name = provider.folder?.trim();
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  }, [allProviders]);

  return (
    <FolderCombobox
      id="provider-folder"
      value={value}
      onChange={onChange}
      existingFolders={folderNames}
      folderCounts={folderCounts}
    />
  );
}
