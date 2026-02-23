import { NavLink } from "react-router-dom";
import { useState } from "react";

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { to: "/", label: "Overview", icon: "grid" },
  { to: "/cost", label: "Cost", icon: "dollar" },
  { to: "/sessions", label: "Sessions", icon: "list" },
  { to: "/tools", label: "Tools", icon: "wrench" },
  { to: "/cache", label: "Cache", icon: "database" },
  { to: "/activity", label: "Activity", icon: "chart" },
];

const iconPaths: Record<string, string[]> = {
  grid: [
    "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  ],
  dollar: [
    "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  ],
  list: [
    "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  ],
  wrench: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  ],
  database: [
    "M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3",
    "M3 6c0 1.66 4.03 3 9 3s9-1.34 9-3",
    "M21 6v12c0 1.66-4.03 3-9 3s-9-1.34-9-3V6",
    "M3 6c0-1.66 4.03-3 9-3s9 1.34 9 3",
  ],
  chart: [
    "M3 3v18h18",
    "M18.7 8l-5.1 5.2-2.8-2.7L7 14.3",
  ],
  chevronLeft: ["M15 18l-6-6 6-6"],
  chevronRight: ["M9 18l6-6-6-6"],
};

function NavIcon({ icon }: { icon: string }) {
  const paths = iconPaths[icon] ?? iconPaths["grid"]!;
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={`
          fixed z-50 flex h-full flex-col border-r transition-all duration-300 lg:relative lg:z-auto
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
          ${collapsed ? "w-[68px]" : "w-60"}
        `}
        style={{
          backgroundColor: "var(--bg-primary)",
          borderColor: "var(--border)",
        }}
      >
        {/* Logo */}
        <div
          className={`flex items-center border-b ${collapsed ? "justify-center px-2" : "gap-3 px-5"} py-6`}
          style={{ borderColor: "var(--border)" }}
        >
          <div
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ backgroundColor: "var(--accent)" }}
          >
            CC
          </div>
          {!collapsed && (
            <span
              className="text-lg font-semibold tracking-tight"
              style={{ color: "var(--text-primary)" }}
            >
              Analytics
            </span>
          )}
        </div>

        {/* Navigation */}
        <nav className={`mt-4 flex flex-1 flex-col gap-1.5 ${collapsed ? "px-2" : "px-3"}`}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={onMobileClose}
              className={({ isActive }) =>
                `sidebar-nav-link group flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
                  collapsed ? "sidebar-nav-link--collapsed justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5"
                }${isActive ? " sidebar-nav-link--active" : ""}`
              }
              title={collapsed ? item.label : undefined}
            >
              <NavIcon icon={item.icon} />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Bottom section */}
        <div
          className={`border-t ${collapsed ? "px-2" : "px-3"} py-4`}
          style={{ borderColor: "var(--border)" }}
        >
          {/* Collapse toggle (hidden on mobile) */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`sidebar-bottom-btn hidden w-full items-center rounded-lg text-xs font-medium transition-colors lg:flex ${
              collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
            }`}
          >
            <NavIcon icon={collapsed ? "chevronRight" : "chevronLeft"} />
            {!collapsed && <span>Collapse</span>}
          </button>

          {/* Version */}
          {!collapsed && (
            <p
              className="mt-2 px-3 text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              CC Analytics v0.1.0
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
