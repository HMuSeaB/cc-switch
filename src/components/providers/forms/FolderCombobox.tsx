import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Folder, FolderPlus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface FolderComboboxProps {
  /** 当前选中的文件夹名（空字符串 / undefined = 未分组） */
  value?: string;
  onChange: (value: string) => void;
  /** 现有文件夹名列表，用于补全 */
  existingFolders: string[];
  /** 每个文件夹下的供应商数量，展示成「名字 · 3」 */
  folderCounts?: Record<string, number>;
  disabled?: boolean;
  id?: string;
}

/**
 * 文件夹选择器：既能从现有文件夹里挑，也能直接打字创建新的。
 *
 * 为什么不用裸 Input：手滑打错字（「官方」vs「官分」）会静默分裂出两个分组，
 * 而且拼写不一致会让「按文件夹分组」视图散成一片。combobox 让用户优先选到
 * 已存在的名字，只在确认真要建新组时才新增。
 */
export function FolderCombobox({
  value,
  onChange,
  existingFolders,
  folderCounts,
  disabled = false,
  id,
}: FolderComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // 弹窗关闭后清空搜索词，避免下次打开残留上次的输入
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim();
  const hasExactMatch = useMemo(
    () =>
      existingFolders.some(
        (f) => f.toLowerCase() === normalizedQuery.toLowerCase(),
      ),
    [existingFolders, normalizedQuery],
  );

  // 过滤：空 query 时列全部；否则按名称包含匹配（大小写不敏感）
  const filtered = useMemo(() => {
    if (!normalizedQuery) return existingFolders;
    const lower = normalizedQuery.toLowerCase();
    return existingFolders.filter((f) => f.toLowerCase().includes(lower));
  }, [existingFolders, normalizedQuery]);

  const showCreateOption =
    normalizedQuery.length > 0 && !hasExactMatch && !disabled;

  const handleSelect = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <Popover modal open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          id={id}
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-default bg-background px-3 py-1 text-sm shadow-sm ring-offset-background",
            "focus:outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value || t("provider.folderNone", { defaultValue: "未分组" })}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            {value && (
              <X
                className="h-3.5 w-3.5 cursor-pointer opacity-50 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange("");
                }}
                aria-label={t("provider.folderClear", {
                  defaultValue: "清除文件夹",
                })}
              />
            )}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[1000] w-[var(--radix-popover-trigger-width)] p-0 border-border-default"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("provider.folderComboboxPlaceholder", {
              defaultValue: "搜索或输入新文件夹名...",
            })}
          />
          <CommandList>
            <CommandEmpty>
              {normalizedQuery
                ? t("provider.folderNoMatch", {
                    defaultValue: "没有匹配的文件夹",
                  })
                : t("provider.folderNoneYet", {
                    defaultValue: "还没有文件夹",
                  })}
            </CommandEmpty>

            {/* 清除归组 */}
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <X className="mr-2 h-3.5 w-3.5" />
                <span className="text-muted-foreground">
                  {t("provider.folderNone", { defaultValue: "未分组" })}
                </span>
                {!value && <Check className="ml-auto h-4 w-4" />}
              </CommandItem>
            </CommandGroup>

            {filtered.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup
                  heading={t("provider.folderExisting", {
                    defaultValue: "现有文件夹",
                  })}
                >
                  {filtered.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      onSelect={() => handleSelect(name)}
                    >
                      <Folder className="mr-2 h-3.5 w-3.5" />
                      <span className="truncate">{name}</span>
                      {folderCounts?.[name] !== undefined && (
                        <span className="ml-1.5 shrink-0 text-xs text-muted-foreground">
                          · {folderCounts[name]}
                        </span>
                      )}
                      {value === name && (
                        <Check className="ml-auto h-4 w-4 shrink-0" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {showCreateOption && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value={`__create__${normalizedQuery}`}
                    onSelect={() => handleSelect(normalizedQuery)}
                  >
                    <FolderPlus className="mr-2 h-3.5 w-3.5" />
                    <span>
                      {t("provider.folderCreateNamed", {
                        name: normalizedQuery,
                        defaultValue: "新建文件夹「{{name}}」",
                      })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
