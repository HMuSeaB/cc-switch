import type { Provider } from "@/types";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";

/**
 * 规范化 URL 字符串，统一用于分组对比与显示
 * 1. 去除首尾空白
 * 2. 移除末尾的所有斜杆 `/`
 * 3. 将 Protocol 和 Host 转化为小写，保持 Query / Path 部分
 */
export function normalizeUrl(url: string): string {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";

  try {
    // 若不包含协议，构造临时 URL 解析
    const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+-.]*:\/\//.test(trimmed);
    const urlToParse = hasProtocol ? trimmed : `http://${trimmed}`;
    const parsed = new URL(urlToParse);

    let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!hasProtocol) {
      // 没协议则去掉补全的 http://
      normalized = normalized.replace(/^http:\/\//, "");
    }
    return normalized.replace(/\/+$/, "");
  } catch {
    // 如果不是标准 URL，做基础去除末尾斜杠
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * 从供应商配置中提取真实的请求 Base URL / API Endpoint
 */
export function getProviderApiUrl(
  provider: Provider,
  fallbackText: string = "",
): string {
  if (!provider) return fallbackText;

  // 1. 若配置了 notes 且是以 http/https 开头的链接
  if (provider.notes && provider.notes.trim()) {
    const notesTrimmed = provider.notes.trim();
    if (
      notesTrimmed.startsWith("http://") ||
      notesTrimmed.startsWith("https://")
    ) {
      return normalizeUrl(notesTrimmed);
    }
  }

  // 2. 若配置了 websiteUrl
  if (provider.websiteUrl && provider.websiteUrl.trim()) {
    return normalizeUrl(provider.websiteUrl);
  }

  // 3. 从 settingsConfig 结构中尝试提取 baseUrl
  const config = provider.settingsConfig;
  if (config && typeof config === "object") {
    const envBase =
      (config as Record<string, any>)?.env?.ANTHROPIC_BASE_URL ||
      (config as Record<string, any>)?.env?.GOOGLE_GEMINI_BASE_URL ||
      (config as Record<string, any>)?.env?.OPENAI_BASE_URL ||
      (config as Record<string, any>)?.env?.BASE_URL ||
      (config as Record<string, any>)?.baseUrl ||
      (config as Record<string, any>)?.base_url ||
      (config as Record<string, any>)?.api_base ||
      (config as Record<string, any>)?.endpoint;

    if (typeof envBase === "string" && envBase.trim()) {
      return normalizeUrl(envBase);
    }

    const codexConfigStr = (config as Record<string, any>)?.config;
    if (
      typeof codexConfigStr === "string" &&
      codexConfigStr.includes("base_url")
    ) {
      const extractedBaseUrl = extractCodexBaseUrl(codexConfigStr);
      if (extractedBaseUrl) {
        return normalizeUrl(extractedBaseUrl);
      }
    }
  }

  // 4. 再次检查 notes
  if (provider.notes && provider.notes.trim()) {
    return provider.notes.trim();
  }

  return fallbackText;
}

/**
 * 获取用于分组归类的 Unique Key
 */
export function getProviderGroupKey(
  provider: Provider,
  fallbackKey: string = "unconfigured",
): string {
  const url = getProviderApiUrl(provider, "");
  if (!url) return fallbackKey;
  return normalizeUrl(url).toLowerCase();
}
