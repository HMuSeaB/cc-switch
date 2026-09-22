import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Provider,
  ProviderFolder,
  UniversalProvider,
  UniversalProvidersMap,
} from "@/types";
import type { AppId } from "./types";

export interface ProviderSortUpdate {
  id: string;
  sortIndex: number;
}

export interface ProviderSwitchEvent {
  appType: AppId;
  providerId: string;
}

export interface SwitchResult {
  warnings: string[];
}

export interface OpenTerminalOptions {
  cwd?: string;
}

// --- 智能分组（TypeSafe / Jev） ---

export type SuggestionSource = "typesafe" | "heuristic";

/** 单条归组建议。suggestedFolder 为 null 表示建议保持未分组。 */
export interface FolderSuggestion {
  providerId: string;
  providerName: string;
  suggestedFolder: string | null;
  /** 0..1，Choice 概率分布的集中程度，不是"对不对"的保证 */
  confidence: number;
  /** 是否高置信度（>= 0.75），前端可据此默认勾选 */
  highConfidence: boolean;
  /** 全候选文件夹的概率分布（含未分组），按概率降序 */
  alternatives: FolderProbability[];
  source: SuggestionSource;
}

export interface FolderProbability {
  /** null = 未分组 */
  folder: string | null;
  probability: number;
}

export interface FolderSuggestResult {
  suggestions: FolderSuggestion[];
  source: SuggestionSource;
  /** 走了降级路径时的原因说明 */
  degradedReason: string | null;
  /** [prompt_tokens, completion_tokens]；走模型且有返回值时才有 */
  usage: [number, number] | null;
}

export interface FolderSuggestConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}

export interface ClaudeDesktopStatus {
  supported: boolean;
  configured: boolean;
  appliedId?: string | null;
  profilePath?: string | null;
  configLibraryPath?: string | null;
  mode?: "direct" | "proxy" | null;
  expectedBaseUrl?: string | null;
  actualBaseUrl?: string | null;
  proxyRunning: boolean;
  staleRawModels: boolean;
  missingRouteMappings: boolean;
  gatewayTokenConfigured: boolean;
}

export interface ClaudeDesktopDefaultRoute {
  routeId: string;
  envKey: string;
  supports1m: boolean;
}

export const providersApi = {
  async getAll(appId: AppId): Promise<Record<string, Provider>> {
    return await invoke("get_providers", { app: appId });
  },

  async getCurrent(appId: AppId): Promise<string> {
    return await invoke("get_current_provider", { app: appId });
  },

  async add(
    provider: Provider,
    appId: AppId,
    addToLive?: boolean,
  ): Promise<boolean> {
    return await invoke("add_provider", { provider, app: appId, addToLive });
  },

  async update(
    provider: Provider,
    appId: AppId,
    originalId?: string,
  ): Promise<boolean> {
    return await invoke("update_provider", {
      provider,
      app: appId,
      originalId,
    });
  },

  async delete(id: string, appId: AppId): Promise<boolean> {
    return await invoke("delete_provider", { id, app: appId });
  },

  /**
   * Remove provider from live config only (for additive mode apps like OpenCode)
   * Does NOT delete from database - provider remains in the list
   */
  async removeFromLiveConfig(id: string, appId: AppId): Promise<boolean> {
    return await invoke("remove_provider_from_live_config", { id, app: appId });
  },

  async switch(id: string, appId: AppId): Promise<SwitchResult> {
    return await invoke("switch_provider", { id, app: appId });
  },

  async importDefault(appId: AppId): Promise<boolean> {
    return await invoke("import_default_config", { app: appId });
  },

  async importClaudeDesktopFromClaude(): Promise<number> {
    return await invoke("import_claude_desktop_providers_from_claude");
  },

  async ensureClaudeDesktopOfficialProvider(): Promise<boolean> {
    return await invoke("ensure_claude_desktop_official_provider");
  },

  async ensureCodexOfficialProvider(): Promise<boolean> {
    return await invoke("ensure_codex_official_provider");
  },

  async ensureGrokBuildOfficialProvider(): Promise<boolean> {
    return await invoke("ensure_grokbuild_official_provider");
  },

  async getClaudeDesktopStatus(): Promise<ClaudeDesktopStatus> {
    return await invoke("get_claude_desktop_status");
  },

  async getClaudeDesktopDefaultRoutes(): Promise<ClaudeDesktopDefaultRoute[]> {
    return await invoke("get_claude_desktop_default_routes");
  },

  async updateTrayMenu(): Promise<boolean> {
    return await invoke("update_tray_menu");
  },

  async updateSortOrder(
    updates: ProviderSortUpdate[],
    appId: AppId,
  ): Promise<boolean> {
    return await invoke("update_providers_sort_order", { updates, app: appId });
  },

  // --- 自定义文件夹 ---

  /** 读取自定义文件夹注册表（已按 sortIndex 排序） */
  async getFolders(appId: AppId): Promise<ProviderFolder[]> {
    return await invoke("get_provider_folders", { app: appId });
  },

  /** 批量把若干供应商移入指定文件夹；folder 传 null/undefined 表示移到未分组 */
  async setProvidersFolder(
    providerIds: string[],
    folder: string | null,
    appId: AppId,
  ): Promise<number> {
    return await invoke("set_providers_folder", {
      providerIds,
      folder,
      app: appId,
    });
  },

  /** 新建文件夹，返回更新后的完整注册表 */
  async createFolder(name: string, appId: AppId): Promise<ProviderFolder[]> {
    return await invoke("create_provider_folder", { name, app: appId });
  },

  /** 重命名文件夹（供应商归组一并改），返回被改动的供应商数量 */
  async renameFolder(
    oldName: string,
    newName: string,
    appId: AppId,
  ): Promise<number> {
    return await invoke("rename_provider_folder", {
      oldName,
      newName,
      app: appId,
    });
  },

  /** 解散文件夹，归属供应商移到未分组，返回被移动的供应商数量 */
  async deleteFolder(name: string, appId: AppId): Promise<number> {
    return await invoke("delete_provider_folder", { name, app: appId });
  },

  /** 保存文件夹排序 */
  async saveFoldersOrder(
    folderNames: string[],
    appId: AppId,
  ): Promise<boolean> {
    return await invoke("save_provider_folders_order", {
      folderNames,
      app: appId,
    });
  },

  /** 保存单个文件夹的展开/收起状态 */
  async setFolderExpanded(
    name: string,
    isExpanded: boolean,
    appId: AppId,
  ): Promise<boolean> {
    return await invoke("set_provider_folder_expanded", {
      name,
      isExpanded,
      app: appId,
    });
  },

  // --- 智能分组（TypeSafe / Jev） ---

  /** 读取智能分组配置状态（只暴露"配没配"，不含真 key） */
  async getFolderSuggestConfig(): Promise<FolderSuggestConfigStatus> {
    return await invoke("get_folder_suggest_config");
  },

  /**
   * 保存 TypeSafe 配置。
   * apiKey 传空/不传 = 保持现有 key 不变；clearApiKey=true 才真正清空。
   */
  async setFolderSuggestConfig(params: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    clearApiKey?: boolean;
  }): Promise<boolean> {
    return await invoke("set_folder_suggest_config", {
      apiKey: params.apiKey ?? null,
      baseUrl: params.baseUrl ?? null,
      model: params.model ?? null,
      clearApiKey: params.clearApiKey ?? false,
    });
  },

  /** 生成未分组供应商的文件夹归组建议（只返回建议，不落库） */
  async suggestProviderFolders(appId: AppId): Promise<FolderSuggestResult> {
    return await invoke("suggest_provider_folders", { app: appId });
  },

  async onSwitched(
    handler: (event: ProviderSwitchEvent) => void,
  ): Promise<UnlistenFn> {
    return await listen("provider-switched", (event) => {
      const payload = event.payload as ProviderSwitchEvent;
      handler(payload);
    });
  },

  /**
   * 打开指定提供商的终端
   * 任何提供商都可以打开终端，不受是否为当前激活提供商的限制
   * 终端会使用该提供商特定的 API 配置，不影响全局设置
   */
  async openTerminal(
    providerId: string,
    appId: AppId,
    options?: OpenTerminalOptions,
  ): Promise<boolean> {
    const { cwd } = options ?? {};
    return await invoke("open_provider_terminal", {
      providerId,
      app: appId,
      cwd,
    });
  },

  /**
   * 从 OpenCode live 配置导入供应商到数据库
   * OpenCode 特有功能：由于累加模式，用户可能已在 opencode.json 中配置供应商
   */
  async importOpenCodeFromLive(): Promise<number> {
    return await invoke("import_opencode_providers_from_live");
  },

  /**
   * 获取 OpenCode live 配置中的供应商 ID 列表
   * 用于前端判断供应商是否已添加到 opencode.json
   */
  async getOpenCodeLiveProviderIds(): Promise<string[]> {
    return await invoke("get_opencode_live_provider_ids");
  },

  /**
   * 获取 OpenClaw live 配置中的供应商 ID 列表
   * 用于前端判断供应商是否已添加到 openclaw.json
   */
  async getOpenClawLiveProviderIds(): Promise<string[]> {
    return await invoke("get_openclaw_live_provider_ids");
  },

  /**
   * 获取 Hermes live 配置中的供应商 ID 列表
   * 用于前端判断供应商是否已添加到 Hermes 配置
   */
  async getHermesLiveProviderIds(): Promise<string[]> {
    return await invoke("get_hermes_live_provider_ids");
  },

  /**
   * 从 OpenClaw live 配置导入供应商到数据库
   * OpenClaw 特有功能：由于累加模式，用户可能已在 openclaw.json 中配置供应商
   */
  async importOpenClawFromLive(): Promise<number> {
    return await invoke("import_openclaw_providers_from_live");
  },

  /**
   * 从 Hermes live 配置导入供应商到数据库
   * Hermes 特有功能：由于累加模式，用户可能已在 Hermes 配置中配置供应商
   */
  async importHermesFromLive(): Promise<number> {
    return await invoke("import_hermes_providers_from_live");
  },
};

// ============================================================================
// 统一供应商（Universal Provider）API
// ============================================================================

export const universalProvidersApi = {
  /**
   * 获取所有统一供应商
   */
  async getAll(): Promise<UniversalProvidersMap> {
    return await invoke("get_universal_providers");
  },

  /**
   * 获取单个统一供应商
   */
  async get(id: string): Promise<UniversalProvider | null> {
    return await invoke("get_universal_provider", { id });
  },

  /**
   * 添加或更新统一供应商
   */
  async upsert(provider: UniversalProvider): Promise<boolean> {
    return await invoke("upsert_universal_provider", { provider });
  },

  /**
   * 删除统一供应商
   */
  async delete(id: string): Promise<boolean> {
    return await invoke("delete_universal_provider", { id });
  },

  /**
   * 手动同步统一供应商到各应用
   */
  async sync(id: string): Promise<boolean> {
    return await invoke("sync_universal_provider", { id });
  },
};
