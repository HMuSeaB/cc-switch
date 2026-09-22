import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { providersApi, type AppId } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";

/**
 * 自定义文件夹注册表查询 key。
 *
 * 注意：不把 appId 放进 key，而是由调用方在 hook 参数里传、拼进 key 末尾。
 * 这样同一个 app 下的创建/重命名/解散 mutation 能精确定位到要失效的缓存。
 */
export const providerFoldersKey = (appId: AppId) => ["providerFolders", appId];
/** localStorage 旧键（迁移前） */
const LEGACY_FOLDERS_KEY = "cc-switch:custom-folders";
const LEGACY_GROUP_BY_FOLDER_KEY = "cc-switch:group-by-folder";

/**
 * 已经跑过迁移的 appId 集合（模块级）。
 *
 * 只在"本次页面会话"内有效，刷新后重新判断——那时数据库里已经有文件夹了，
 * 走的是 `folders.length > 0` 那条分支，不会再迁移。
 * 存在的意义是挡住 React 18 开发态重复挂载导致的并发重复创建。
 */
const MIGRATED_APP_IDS = new Set<string>();

/**
 * 读取旧 localStorage 里的文件夹名。
 *
 * 旧结构是个裸 string[]，没有任何不变式保护——历史数据里出现重复项是可能的
 * （用户先后手改过 / 迁移逻辑自身的残留）。这里按「trim 后首次出现」去重并
 * 保序，让迁移不会对同一个名字重复发起创建。
 */
function readLegacyFolders(): string[] {
  try {
    const saved = localStorage.getItem(LEGACY_FOLDERS_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 供应商自定义文件夹注册表。
 *
 * 历史：注册表原先存在 localStorage（`cc-switch:custom-folders`），只有本机可见、
 * 清浏览器数据即丢，也不随 WebDAV/S3 同步走。现在改存数据库（Rust 端
 * `provider_folders_{app_type}`），同步整库 db.sql 时自动跨设备。
 *
 * 迁移：首次读到「DB 为空 + localStorage 有数据」时，把 localStorage 里的名字
 * 补进注册表并落库，然后删掉旧 key。只跑一次，失败不影响使用（顶多少几个分组）。
 */
export function useProviderFolders(appId: AppId) {
  const queryClient = useQueryClient();
  const queryKey = providerFoldersKey(appId);

  const { data: folders = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => providersApi.getFolders(appId),
    staleTime: 30_000,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const migrateIfNeeded = useCallback(async () => {
    // 模块级 + appId 级别的双保险：React 18 开发态会重复挂载，同一批
    // legacy 名字可能被两个挂载实例同时读到（都发生在第一个删 key 之前），
    // ref 挡不住跨实例的重复，所以这里用模块级 Set 兜底。
    if (MIGRATED_APP_IDS.has(appId)) return;

    const legacy = readLegacyFolders();
    if (legacy.length === 0) {
      MIGRATED_APP_IDS.add(appId);
      return;
    }

    // 关键：在读完之后、异步创建之前就删掉旧 key + 记下已迁移。
    // 删除不可逆，所以先把名单取到本地变量再用。
    MIGRATED_APP_IDS.add(appId);
    localStorage.removeItem(LEGACY_FOLDERS_KEY);
    localStorage.removeItem(LEGACY_GROUP_BY_FOLDER_KEY);

    // 逐个补：Rust 端 create_provider_folder 已按 name 去重，
    // 撞名的直接报错，忽略即可（并发下可能被别的流程先建了）。
    let created = 0;
    for (const name of legacy) {
      try {
        await providersApi.createFolder(name, appId);
        created += 1;
      } catch {
        // 已存在 / 并发创建 → 忽略
      }
    }
    if (created > 0) {
      toast.success(`已迁移 ${created} 个文件夹到本地数据库`);
    }
    invalidate();
  }, [appId, invalidate]);

  // 查询回来后自动尝试一次性迁移。
  //
  // 判据用「旧 key 是否还存在」而不是 ref：迁移的 async 循环跑完才删 key，
  // 这期间任何重渲染 / 重新挂载都会让 ref 归零并再跑一遍（实测会重复创建
  // 第一个文件夹）。把 key 的删除提前到"读完之后、开跑之前"，再配合
  // ref 兜住同步窗口，就能保证每个名字只被创建一次。
  const migrationAttempted = useRef(false);
  useEffect(() => {
    if (isLoading || migrationAttempted.current) return;
    migrationAttempted.current = true;

    // 注册表非空 → 已经是新世界，顺手把残留的旧 key 清掉
    if (folders.length > 0) {
      localStorage.removeItem(LEGACY_FOLDERS_KEY);
      localStorage.removeItem(LEGACY_GROUP_BY_FOLDER_KEY);
      return;
    }

    void migrateIfNeeded();
  }, [isLoading, folders.length, migrateIfNeeded]);

  const folderNames = useMemo(() => folders.map((f) => f.name), [folders]);

  const createFolder = useMutation({
    mutationFn: (name: string) => providersApi.createFolder(name, appId),
    onSuccess: () => invalidate(),
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || "创建文件夹失败");
    },
  });

  const renameFolder = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      providersApi.renameFolder(oldName, newName, appId),
    onSuccess: (_count, { newName }) => {
      invalidate();
      // 改名会动供应商的 folder 字段，供应商列表必须一起刷新
      queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });
      toast.success(`已重命名为「${newName}」`);
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || "重命名文件夹失败");
    },
  });

  const deleteFolder = useMutation({
    mutationFn: (name: string) => providersApi.deleteFolder(name, appId),
    onSuccess: (moved) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });
      toast.success(
        moved > 0
          ? `已解散文件夹，${moved} 个供应商移到未分组`
          : "已解散文件夹",
      );
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || "解散文件夹失败");
    },
  });

  const setProvidersFolder = useMutation({
    mutationFn: ({
      providerIds,
      folder,
    }: {
      providerIds: string[];
      folder: string | null;
    }) => providersApi.setProvidersFolder(providerIds, folder, appId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });
      // 归组后注册表可能要新增条目（供应商带了个没登记过的 folder 名）
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || "移动供应商失败");
    },
  });

  const saveOrder = useMutation({
    mutationFn: (folderNames: string[]) =>
      providersApi.saveFoldersOrder(folderNames, appId),
    onSuccess: () => invalidate(),
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || "保存文件夹排序失败");
    },
  });

  return {
    folders,
    folderNames,
    isLoading,
    migrateIfNeeded,
    createFolder,
    renameFolder,
    deleteFolder,
    setProvidersFolder,
    saveOrder,
  };
}

/** 供非组件场景读取旧 localStorage 分组开关（兼容老用户默认开启） */
export function readLegacyGroupByFolder(): boolean {
  const saved = localStorage.getItem(LEGACY_GROUP_BY_FOLDER_KEY);
  return saved !== null ? saved === "true" : true;
}
