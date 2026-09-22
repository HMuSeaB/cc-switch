import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFolderSuggest } from "@/hooks/useFolderSuggest";

/**
 * TypeSafe (Jev) 智能分组配置。
 *
 * 注意 API Key 的处理：`get_settings` 回给前端的是**清空后**的值（后端
 * `get_settings_for_frontend` 会 clear），所以输入框只用来"设新值"或"清空"，
 * 不回显已保存的 key。用占位符提示当前是否已配置。
 */
export function TypeSafeSection() {
  const { t } = useTranslation();
  const { configured, config, saveConfig } = useFolderSuggest("claude");

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");

  // 配置拉回来后填充地址/模型（这两项不是凭据，可以回显）
  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.baseUrl);
    setModel(config.model);
  }, [config]);

  const handleSave = () => {
    saveConfig.mutate({
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim() || undefined,
    });
    setApiKey("");
  };

  const handleClear = () => {
    saveConfig.mutate({ clearApiKey: true });
    setApiKey("");
  };

  const isSaving = saveConfig.isPending;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="typesafe-api-key" className="text-xs font-medium">
          {t("settings.typesafe.apiKey", { defaultValue: "TypeSafe API Key" })}
        </Label>
        <Input
          id="typesafe-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            configured
              ? t("settings.typesafe.apiKeyConfigured", {
                  defaultValue: "已配置（输入新值可替换）",
                })
              : t("settings.typesafe.apiKeyPlaceholder", {
                  defaultValue: "粘贴你的 TypeSafe API Key",
                })
          }
          className="h-9 rounded-xl bg-muted/40 border-border/60 focus:bg-card transition-all"
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("settings.typesafe.apiKeyHint", {
            defaultValue:
              "仅存于本机设置，不随云同步。留空保存不会改动已配置的 Key。",
          })}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="typesafe-base-url" className="text-xs font-medium">
            {t("settings.typesafe.baseUrl", { defaultValue: "API 地址" })}
          </Label>
          <Input
            id="typesafe-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.typesafe.ai/v1"
            className="h-9 rounded-xl bg-muted/40 border-border/60 focus:bg-card transition-all"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="typesafe-model" className="text-xs font-medium">
            {t("settings.typesafe.model", { defaultValue: "模型" })}
          </Label>
          <Input
            id="typesafe-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="jev-latest"
            className="h-9 rounded-xl bg-muted/40 border-border/60 focus:bg-card transition-all"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={handleSave}
          disabled={isSaving}
          size="sm"
          className="h-9 rounded-xl text-xs font-medium"
        >
          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
          {isSaving
            ? t("common.saving", { defaultValue: "保存中..." })
            : t("common.save", { defaultValue: "保存" })}
        </Button>
        {configured && (
          <Button
            variant="ghost"
            onClick={handleClear}
            disabled={isSaving}
            size="sm"
            className="h-9 rounded-xl text-xs text-destructive hover:text-destructive"
          >
            {t("settings.typesafe.clearKey", { defaultValue: "清除 Key" })}
          </Button>
        )}
      </div>
    </div>
  );
}
