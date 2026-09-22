import { useState, useEffect, type ReactNode } from "react";
import {
  Folder,
  FolderOpen,
  ChevronDown,
  CheckCircle2,
  MoreHorizontal,
  Edit3,
  Trash2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface ProviderFolderCardProps {
  /** 文件夹显示名称（或 URL） */
  name?: string;
  /** 兼容旧版 url 属性 */
  url?: string;
  count: number;
  containsCurrent?: boolean;
  defaultExpanded?: boolean;
  /** 外部一键展开/收起覆盖状态 */
  forceExpand?: boolean | null;
  /** 是否为用户自定义文件夹（非 URL 自动聚合） */
  isCustomFolder?: boolean;
  onRename?: () => void;
  onDelete?: () => void;
  children: ReactNode;
}

export function ProviderFolderCard({
  name,
  url,
  count,
  containsCurrent = false,
  defaultExpanded = true,
  forceExpand = null,
  isCustomFolder = false,
  onRename,
  onDelete,
  children,
}: ProviderFolderCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const displayName =
    name || url || t("provider.defaultFolder", { defaultValue: "未分组" });

  useEffect(() => {
    if (forceExpand !== null && forceExpand !== undefined) {
      setIsExpanded(forceExpand);
    }
  }, [forceExpand]);

  return (
    <div
      className={cn(
        "rounded-2xl border transition-all duration-200 overflow-hidden bg-card/70 backdrop-blur-md shadow-sm",
        containsCurrent
          ? "border-primary/40 bg-primary/[0.03] shadow-primary/5 ring-1 ring-primary/20"
          : "border-border/60 hover:border-border/80 hover:shadow-md",
      )}
    >
      {/* Folder Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/20 hover:bg-muted/40 transition-colors group">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer select-none text-left"
        >
          <div
            className={cn(
              "p-2 rounded-xl transition-colors shrink-0 shadow-xs",
              containsCurrent
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground group-hover:text-foreground group-hover:bg-muted/80",
            )}
          >
            {isExpanded ? (
              <FolderOpen className="w-4 h-4" />
            ) : (
              <Folder className="w-4 h-4" />
            )}
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm truncate text-foreground tracking-tight">
              {displayName}
            </span>
            {containsCurrent && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                {t("common.active", { defaultValue: "当前使用" })}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted/60 font-medium">
            {t("provider.folderNodesCount", {
              count,
              defaultValue: `${count} 节点`,
            })}
          </span>

          {/* 针对自定义文件夹的管理菜单 */}
          {isCustomFolder && (onRename || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36 rounded-xl">
                {onRename && (
                  <DropdownMenuItem
                    onClick={onRename}
                    className="gap-2 text-xs"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>
                      {t("provider.renameFolder", { defaultValue: "重命名" })}
                    </span>
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={onDelete}
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>
                      {t("provider.deleteFolder", {
                        defaultValue: "解散文件夹",
                      })}
                    </span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className="p-1 rounded-lg hover:bg-muted text-muted-foreground transition-all cursor-pointer"
            aria-label={isExpanded ? "收起" : "展开"}
          >
            <ChevronDown
              className={cn(
                "w-4 h-4 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>

      {/* Folder Contents */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden border-t border-border/40"
          >
            <div className="p-3 pl-4 sm:pl-6 space-y-3 bg-muted/5 border-l-2 border-primary/20 my-2 ml-4 mr-2 rounded-r-xl">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
