import { useTranslation } from "react-i18next";
import {
  Cpu,
  Book,
  Brain,
  History,
  Wrench,
  Settings,
  FolderArchive,
  Sparkles,
  Bot,
  Globe,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { AppSwitcher } from "@/components/AppSwitcher";
import { ProfileSwitcher } from "@/components/profiles/ProfileSwitcher";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";
import { FailoverToggle } from "@/components/proxy/FailoverToggle";
import { UpdateBadge } from "@/components/UpdateBadge";

export type View =
  | "providers"
  | "settings"
  | "prompts"
  | "skills"
  | "skillsDiscovery"
  | "mcp"
  | "agents"
  | "universal"
  | "sessions"
  | "workspace"
  | "openclawEnv"
  | "openclawTools"
  | "openclawAgents"
  | "hermesMemory";

interface AppSidebarProps {
  activeApp: AppId;
  onSwitchApp: (app: AppId) => void;
  visibleApps?: VisibleApps;
  currentView: View;
  onViewChange: (view: View) => void;
  providerCount?: number;
  onOpenAddProvider: () => void;
}

export function AppSidebar({
  activeApp,
  onSwitchApp,
  visibleApps,
  currentView,
  onViewChange,
  providerCount = 0,
  onOpenAddProvider,
}: AppSidebarProps) {
  const { t } = useTranslation();

  const sharedFeatureApp: AppId =
    activeApp === "claude-desktop" ? "claude" : activeApp;
  const supportsSessions =
    sharedFeatureApp === "claude" || sharedFeatureApp === "codex";

  const mainNavItems = [
    {
      id: "providers" as View,
      label: t("header.providers", { defaultValue: "供应商" }),
      icon: Cpu,
      badge: providerCount > 0 ? providerCount : undefined,
    },
    {
      id: "prompts" as View,
      label: t("header.prompts", { defaultValue: "提示词" }),
      icon: Book,
    },
    {
      id: "skills" as View,
      label: t("header.skills", { defaultValue: "技能库" }),
      icon: Brain,
    },
    ...(supportsSessions
      ? [
          {
            id: "sessions" as View,
            label: t("header.sessions", { defaultValue: "历史会话" }),
            icon: History,
          },
        ]
      : []),
  ];

  const toolsNavItems = [
    {
      id: "mcp" as View,
      label: "MCP",
      icon: Wrench,
    },
    {
      id: "agents" as View,
      label: t("header.agents", { defaultValue: "智能体" }),
      icon: Bot,
    },
    {
      id: "universal" as View,
      label: t("header.universal", { defaultValue: "统一供应商" }),
      icon: Globe,
    },
    {
      id: "workspace" as View,
      label: t("header.workspace", { defaultValue: "工作区" }),
      icon: FolderArchive,
    },
  ];

  return (
    <aside
      className="w-64 shrink-0 h-full flex flex-col justify-between border-r border-border/60 bg-card/50 backdrop-blur-xl select-none z-30 transition-all duration-300"
      style={{ WebkitAppRegion: "no-drag" } as any}
    >
      {/* Top Header & Switcher */}
      <div className="flex flex-col p-4 space-y-4">
        {/* Brand / Logo Title */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-primary to-primary/70 flex items-center justify-center text-primary-foreground shadow-sm shadow-primary/25">
              <Sparkles className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-sm tracking-tight text-foreground leading-none">
                CC Switch
              </span>
              <span className="text-[10px] text-muted-foreground mt-0.5">
                Modern Studio
              </span>
            </div>
          </div>
          <UpdateBadge />
        </div>

        {/* App Switcher & Profile Switcher */}
        <div className="space-y-2 pt-1">
          <div className="w-full">
            <AppSwitcher
              activeApp={activeApp}
              onSwitch={onSwitchApp}
              visibleApps={visibleApps}
            />
          </div>
          <div className="w-full">
            <ProfileSwitcher activeApp={activeApp} />
          </div>
        </div>

        {/* Quick Add Provider Action */}
        <Button
          onClick={onOpenAddProvider}
          size="sm"
          className="w-full h-9 rounded-xl gap-2 font-medium shadow-xs text-xs"
        >
          <Plus className="w-4 h-4" />
          <span>{t("provider.addProvider", { defaultValue: "添加供应商" })}</span>
        </Button>
      </div>

      {/* Center Navigation Links */}
      <div className="flex-1 overflow-y-auto px-3 py-1 space-y-5">
        {/* Section 1: Main */}
        <div className="space-y-1">
          <div className="px-3 pb-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
            {t("sidebar.main", { defaultValue: "基础功能" })}
          </div>
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onViewChange(item.id)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all group cursor-pointer",
                  isActive
                    ? "bg-primary/15 text-primary shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={cn(
                      "w-4 h-4 shrink-0 transition-colors",
                      isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </div>
                {item.badge !== undefined && (
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full font-mono font-medium",
                      isActive
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Section 2: Tools & Integrations */}
        <div className="space-y-1">
          <div className="px-3 pb-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
            {t("sidebar.tools", { defaultValue: "扩展集成" })}
          </div>
          {toolsNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onViewChange(item.id)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all group cursor-pointer",
                  isActive
                    ? "bg-primary/15 text-primary shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={cn(
                      "w-4 h-4 shrink-0 transition-colors",
                      isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom Footer: Toggles & Settings */}
      <div className="p-3 border-t border-border/50 bg-muted/15 space-y-2.5">
        <div className="flex items-center justify-between px-1 gap-1">
          <ProxyToggle activeApp={activeApp} />
          <FailoverToggle activeApp={activeApp} />
        </div>

        <button
          type="button"
          onClick={() => onViewChange("settings")}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all group cursor-pointer",
            currentView === "settings"
              ? "bg-primary/15 text-primary font-semibold"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
          )}
        >
          <div className="flex items-center gap-2.5">
            <Settings
              className={cn(
                "w-4 h-4 transition-colors",
                currentView === "settings"
                  ? "text-primary"
                  : "text-muted-foreground group-hover:text-foreground",
              )}
            />
            <span>{t("header.settings", { defaultValue: "设置" })}</span>
          </div>
          <span className="text-[10px] text-muted-foreground/60 font-mono">
            Ctrl+,
          </span>
        </button>
      </div>
    </aside>
  );
}