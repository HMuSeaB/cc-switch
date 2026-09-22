import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Folder, FolderPlus, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { FolderSuggestResult } from "@/lib/api/providers";
import type { AppId } from "@/lib/api";
import { useFolderSuggest } from "@/hooks/useFolderSuggest";

interface FolderSuggestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
}

/** 置信度展示用的颜色分档 */
function confidenceTone(confidence: number): string {
  if (confidence >= 0.75) return "text-emerald-600 dark:text-emerald-400";
  if (confidence >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/**
 * 智能分组建议审查弹窗。
 *
 * 设计要点：
 * - **默认勾选高置信度且确有归组目标的建议**，低置信度和"保持未分组"默认不勾。
 *   用户要做的只是扫一眼、取消个别不满意的，而不是从零勾选。
 * - 每行可以单独改判（下拉换成别的文件夹或未分组）。
 * - 顶部说明数据来源：走的是模型还是本地启发式降级。
 */
export function FolderSuggestDialog({
  open,
  onOpenChange,
  appId,
}: FolderSuggestDialogProps) {
  const { t } = useTranslation();
  const { configured, suggest, applySuggestions } = useFolderSuggest(appId);

  // 用户对每条建议的最终决定：providerId -> 目标文件夹（null = 未分组）
  const [decisions, setDecisions] = useState<Record<string, string | null>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const result: FolderSuggestResult | undefined = suggest.data;

  /**
   * 下拉框可用全部文件夹名的汇总，按概率/出现次序去重。
   *
   * 为什么不能只列 `s.alternatives`：走本地启发式降级时后端不下发 alternatives，
   * 那样下拉框就只剩"未分组"一项，用户想改判成别的文件夹时无从下手。
   * 这里把所有建议里出现过的文件夹名并进来，保证任何路径下都能改判。
   */
  const allFolders = useMemo(() => {
    const names: string[] = [];
    if (result) {
      for (const s of result.suggestions) {
        if (s.suggestedFolder && !names.includes(s.suggestedFolder)) {
          names.push(s.suggestedFolder);
        }
        for (const a of s.alternatives) {
          if (a.folder && !names.includes(a.folder)) {
            names.push(a.folder);
          }
        }
      }
    }
    return names;
  }, [result]);

  // 新结果到达时按规则初始化默认勾选与决定
  useEffect(() => {
    if (!result) return;
    const nextDecisions: Record<string, string | null> = {};
    const nextChecked: Record<string, boolean> = {};
    for (const s of result.suggestions) {
      nextDecisions[s.providerId] = s.suggestedFolder;
      // 只默认采纳「高置信度 + 确实要归组」的；未分组建议勾了也没意义
      nextChecked[s.providerId] =
        s.highConfidence && s.suggestedFolder !== null;
    }
    setDecisions(nextDecisions);
    setChecked(nextChecked);
  }, [result]);

  const checkedCount = useMemo(
    () => Object.values(checked).filter(Boolean).length,
    [checked],
  );

  const handleGenerate = () => {
    suggest.mutate();
  };

  const handleApply = () => {
    const assignments = Object.entries(decisions)
      .filter(([providerId]) => checked[providerId])
      .map(([providerId, folder]) => ({ providerId, folder }));
    if (assignments.length === 0) return;

    applySuggestions.mutate(assignments, {
      onSuccess: () => onOpenChange(false),
    });
  };

  const isGenerating = suggest.isPending;
  const isApplying = applySuggestions.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-card/95 backdrop-blur-md border border-border/70 shadow-2xl rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Sparkles className="w-4 h-4" />
            </div>
            <span>
              {t("provider.smartGroupTitle", { defaultValue: "智能分组" })}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("provider.smartGroupDesc", {
              defaultValue:
                "由 TypeSafe (Jev) 判断每个未分组供应商该进哪个文件夹。建议仅供审查，确认后才会写入。",
            })}
          </DialogDescription>
        </DialogHeader>

        {!configured && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {t("provider.suggestNotConfigured", {
                defaultValue:
                  "尚未配置 TypeSafe API Key，将使用本地启发式匹配（效果有限）。可在设置中配置以获得模型判断。",
              })}
            </span>
          </div>
        )}

        {result?.degradedReason && (
          <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{result.degradedReason}</span>
          </div>
        )}

        {!result && (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <p className="text-xs text-muted-foreground text-center max-w-sm">
              {t("provider.smartGroupHint", {
                defaultValue:
                  "点击下方按钮，为当前未分组的供应商生成归组建议。",
              })}
            </p>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="rounded-xl h-9 text-xs font-medium"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("provider.suggestGenerating", {
                    defaultValue: "分析中...",
                  })}
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  {t("provider.suggestGenerate", { defaultValue: "生成建议" })}
                </>
              )}
            </Button>
          </div>
        )}

        {result && result.suggestions.length === 0 && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            {t("provider.suggestEmpty", {
              defaultValue: "没有需要归组的供应商。",
            })}
          </div>
        )}

        {result && result.suggestions.length > 0 && (
          <ScrollArea className="max-h-[22rem] pr-3">
            <div className="space-y-2">
              {result.suggestions.map((s) => {
                const target = decisions[s.providerId] ?? null;
                const isChecked = checked[s.providerId] ?? false;

                return (
                  <div
                    key={s.providerId}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                      isChecked
                        ? "border-primary/30 bg-primary/[0.03]"
                        : "border-border/60 bg-muted/20",
                    )}
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={(v) =>
                        setChecked((prev) => ({
                          ...prev,
                          [s.providerId]: v === true,
                        }))
                      }
                      aria-label={t("provider.suggestToggle", {
                        defaultValue: "采纳此建议",
                      })}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {s.providerName}
                        </span>
                        <span
                          className={cn(
                            "text-[11px] font-medium shrink-0",
                            confidenceTone(s.confidence),
                          )}
                          title={t("provider.suggestConfidenceHint", {
                            defaultValue: "模型概率分布的集中程度，仅供参考",
                          })}
                        >
                          {(s.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Folder className="w-3 h-3 text-muted-foreground shrink-0" />
                        <select
                          value={target ?? ""}
                          onChange={(e) =>
                            setDecisions((prev) => ({
                              ...prev,
                              [s.providerId]: e.target.value || null,
                            }))
                          }
                          className="h-7 max-w-full rounded-md border border-border-default bg-background px-2 text-xs shadow-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          aria-label={t("provider.suggestChangeFolder", {
                            defaultValue: "更改目标文件夹",
                          })}
                        >
                          <option value="">
                            {t("provider.folderNone", {
                              defaultValue: "未分组",
                            })}
                          </option>
                          {/* 目标文件夹在下拉里，名字后面标注它是新建的 */}
                          {allFolders.map((name) => {
                            const isNew =
                              result?.suggestions.some(
                                (s) =>
                                  s.suggestedFolder === name && s.isNewFolder,
                              ) ?? false;
                            return (
                              <option key={name} value={name}>
                                {isNew ? `${name} (${t("provider.suggestNewFolder", { defaultValue: "新建" })})` : name}
                              </option>
                            );
                          })}
                        </select>
                        {s.highConfidence && s.suggestedFolder && (
                          <Badge
                            variant="secondary"
                            className="h-5 shrink-0 gap-1 px-1.5 text-[10px] font-normal bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                          >
                            <Check className="w-2.5 h-2.5" />
                            {t("provider.suggestHighConfidence", {
                              defaultValue: "高置信",
                            })}
                          </Badge>
                        )}
                        {s.isNewFolder && s.suggestedFolder && (
                          <Badge
                            variant="secondary"
                            className="h-5 shrink-0 gap-1 px-1.5 text-[10px] font-normal bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
                            title={t("provider.suggestNewFolderHint", {
                              defaultValue: "这个文件夹还不存在，采纳时会自动创建",
                            })}
                          >
                            <FolderPlus className="w-2.5 h-2.5" />
                            {t("provider.suggestNewFolder", {
                              defaultValue: "新建",
                            })}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <div className="mr-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {result && result.suggestions.length > 0 && (
              <span>
                {t("provider.suggestSelectedCount", {
                  count: checkedCount,
                  defaultValue: "已选 {{count}} 项",
                })}
              </span>
            )}
            {result?.usage && result.usage[0] + result.usage[1] > 0 && (
              <span>{result.usage[0] + result.usage[1]} tokens</span>
            )}
          </div>

          {result && result.suggestions.length > 0 && (
            <Button
              variant="ghost"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="rounded-xl h-9 text-xs"
            >
              {isGenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                t("provider.suggestRegenerate", { defaultValue: "重新生成" })
              )}
            </Button>
          )}

          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="rounded-xl h-9 text-xs"
          >
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          {result && result.suggestions.length > 0 && (
            <Button
              onClick={handleApply}
              disabled={isApplying || checkedCount === 0}
              className="rounded-xl h-9 text-xs font-medium shadow-sm"
            >
              {isApplying
                ? t("common.saving", { defaultValue: "保存中..." })
                : t("provider.suggestApply", { defaultValue: "应用所选" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
