import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FolderPlus, Edit3 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface FolderManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "rename";
  initialName?: string;
  existingFolders: string[];
  onSave: (name: string) => Promise<void> | void;
}

export function FolderManageDialog({
  open,
  onOpenChange,
  mode,
  initialName = "",
  existingFolders,
  onSave,
}: FolderManageDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
      setIsSubmitting(false);
    }
  }, [open, initialName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(
        t("provider.folderNameRequired", {
          defaultValue: "文件夹名称不能为空",
        }),
      );
      return;
    }
    if (
      trimmed.toLowerCase() !== initialName.trim().toLowerCase() &&
      existingFolders.some(
        (f) => f.trim().toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setError(
        t("provider.folderNameExists", { defaultValue: "该文件夹已存在" }),
      );
      return;
    }

    try {
      setIsSubmitting(true);
      await onSave(trimmed);
      onOpenChange(false);
    } catch (err: any) {
      setError(err?.message || "操作失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card/95 backdrop-blur-md border border-border/70 shadow-2xl rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            {mode === "create" ? (
              <>
                <div className="p-2 rounded-lg bg-primary/10 text-primary">
                  <FolderPlus className="w-4 h-4" />
                </div>
                <span>
                  {t("provider.createFolder", { defaultValue: "新建文件夹" })}
                </span>
              </>
            ) : (
              <>
                <div className="p-2 rounded-lg bg-primary/10 text-primary">
                  <Edit3 className="w-4 h-4" />
                </div>
                <span>
                  {t("provider.renameFolder", { defaultValue: "重命名文件夹" })}
                </span>
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label
              htmlFor="folder-name"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("provider.folderNameLabel", { defaultValue: "文件夹名称" })}
            </Label>
            <div className="relative">
              <Folder className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                id="folder-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={t("provider.folderNamePlaceholder", {
                  defaultValue: "例如：主力官方、国内中转、DeepSeek",
                })}
                className="pl-9 h-10 rounded-xl bg-muted/40 border-border/60 focus:bg-card transition-all"
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-destructive mt-1">{error}</p>}
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="rounded-xl h-9 text-xs"
              disabled={isSubmitting}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              type="submit"
              className="rounded-xl h-9 text-xs font-medium shadow-sm"
              disabled={isSubmitting}
            >
              {isSubmitting
                ? t("common.saving", { defaultValue: "保存中..." })
                : mode === "create"
                  ? t("common.create", { defaultValue: "创建" })
                  : t("common.save", { defaultValue: "保存" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
