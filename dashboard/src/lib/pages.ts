import {
  LayoutGrid,
  DollarSign,
  List,
  MessageSquare,
  Wrench,
  Database,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export interface PageConfig {
  path: string;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
}

export const pages: PageConfig[] = [
  { path: "/", label: "Overview", icon: LayoutGrid, keywords: ["dashboard", "home", "overview"] },
  { path: "/cost", label: "Cost Analysis", icon: DollarSign, keywords: ["cost", "spend", "budget", "money"] },
  { path: "/sessions", label: "Sessions", icon: List, keywords: ["sessions", "conversations", "history"] },
  { path: "/prompts", label: "Prompts", icon: MessageSquare, keywords: ["prompts", "messages", "chat"] },
  { path: "/tools", label: "Tools", icon: Wrench, keywords: ["tools", "functions", "api"] },
  { path: "/cache", label: "Cache", icon: Database, keywords: ["cache", "hit", "miss", "performance"] },
  { path: "/activity", label: "Activity", icon: TrendingUp, keywords: ["activity", "usage", "chart", "timeline"] },
];
