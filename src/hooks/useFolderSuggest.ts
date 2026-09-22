import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AppId } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 智能分组配置查询 key */
export const folderSuggestConfigKey = ["folderSuggestConfig"] as const;

/**
 * 智能分组（TypeSafe / Jev）配置与建议。
 *
 * 建议**永远不会自动落库**：拿到结果后由 `FolderSuggestDialog` 逐条给用户
 * 审查，用户勾选要采纳的那些，再由 `applySuggestions` 调批量命令写入。
 */
export function useFolderSuggest(appId: AppId) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const configQuery = useQuery({
    queryKey: folderSuggestConfigKey,
    queryFn: () => providersApi.getFolderSuggestConfig(),
    staleTime: 60_000,
  });

  const saveConfig = useMutation({
    mutationFn: (params: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      clearApiKey?: boolean;
    }) => providersApi.setFolderSuggestConfig(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: folderSuggestConfigKey });
      toast.success(
        t("provider.suggestConfigSaved", {
          defaultValue: "智能分组配置已保存",
        }),
      );
    },
    onError: (error: unknown) => {
      toast.error(
        extractErrorMessage(error) ||
          t("provider.suggestConfigSaveFailed", {
            defaultValue: "保存智能分组配置失败",
          }),
      );
    },
  });

  const suggest = useMutation({
    mutationFn: () => providersApi.suggestProviderFolders(appId),
    onError: (error: unknown) => {
      toast.error(
        extractErrorMessage(error) ||
          t("provider.suggestFailed", { defaultValue: "生成智能分组建议失败" }),
      );
    },
  });

  const invalidateProviders = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    queryClient.invalidateQueries({ queryKey: ["providerFolders", appId] });
    queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });
  }, [queryClient, appId]);

  /**
   * 批量应用建议。`assignments` 是用户最终确认的「供应商 -> 文件夹」列表，
   * `null` 表示移到未分组。按文件夹分组合并成尽量少的批量调用。
   */
  const applySuggestions = useMutation({
    mutationFn: async (
      assignments: Array<{ providerId: string; folder: string | null }>,
    ) => {
      const byFolder = new Map<string | null, string[]>();
      for (const { providerId, folder } of assignments) {
        const list = byFolder.get(folder) ?? [];
        list.push(providerId);
        byFolder.set(folder, list);
      }

      let moved = 0;
      for (const [folder, providerIds] of byFolder) {
        moved += await providersApi.setProvidersFolder(
          providerIds,
          folder,
          appId,
        );
      }
      return moved;
    },
    onSuccess: (moved) => {
      invalidateProviders();
      toast.success(
        t("provider.suggestApplied", {
          count: moved,
          defaultValue: "已应用 {{count}} 个供应商的分组",
        }),
      );
    },
    onError: (error: unknown) => {
      toast.error(
        extractErrorMessage(error) ||
          t("provider.suggestApplyFailed", { defaultValue: "应用分组失败" }),
      );
    },
  });

  return {
    configured: configQuery.data?.configured ?? false,
    config: configQuery.data,
    isLoadingConfig: configQuery.isLoading,
    saveConfig,
    suggest,
    applySuggestions,
  };
}
