import { Outlet } from "react-router-dom";
import { useState } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

export default function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar onMenuClick={() => setMobileMenuOpen(true)} />
        <main
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-5 sm:p-6 lg:p-8"
          style={{ backgroundColor: "var(--bg-primary)" }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
