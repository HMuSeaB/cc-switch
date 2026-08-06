import { useState } from "react";
import { Folder, FolderOpen, ChevronDown, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface ProviderFolderCardProps {
  url: string;
  count: number;
  containsCurrent?: boolean;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export function ProviderFolderCard({
  url,
  count,
  containsCurrent = false,
  defaultExpanded = true,
  children,
}: ProviderFolderCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div
      className={cn(
        "rounded-xl border transition-all duration-200 overflow-hidden bg-card/60 backdrop-blur-sm shadow-sm",
        containsCurrent
          ? "border-primary/40 bg-primary/[0.02] shadow-primary/5"
          : "border-border/60 hover:border-border",
      )}
    >
      {/* Folder Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-muted/40 transition-colors text-left group"
      >
        <div className="flex items-center gap-3 min-w-0 pr-2">
          <div
            className={cn(
              "p-2 rounded-lg transition-colors shrink-0",
              containsCurrent
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground group-hover:text-foreground",
            )}
          >
            {isExpanded ? (
              <FolderOpen className="w-4 h-4" />
            ) : (
              <Folder className="w-4 h-4" />
            )}
          </div>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate font-mono text-foreground">
                {url}
              </span>
              {containsCurrent && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                  <CheckCircle2 className="w-3 h-3" />
                  {t("common.active", { defaultValue: "当前使用" })}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted/60 font-medium">
            {t("provider.folderNodesCount", {
              count,
              defaultValue: `${count} 个供应商`,
            })}
          </span>
          <div
            className={cn(
              "text-muted-foreground transition-transform duration-200",
              isExpanded && "rotate-180",
            )}
          >
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </button>

      {/* Folder Contents */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden border-t border-border/40"
          >
            <div className="p-3 pl-4 sm:pl-6 space-y-3 bg-muted/10 border-l-2 border-primary/20 my-2 ml-4 mr-2 rounded-r-lg">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
