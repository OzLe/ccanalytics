import { Routes, Route } from "react-router-dom";
import { FilterProvider } from "@/hooks/useFilters";
import Layout from "@/components/layout/Layout";
import DashboardPage from "@/pages/DashboardPage";
import CostAnalysisPage from "@/pages/CostAnalysisPage";
import SessionsPage from "@/pages/SessionsPage";
import SessionDetailPage from "@/pages/SessionDetailPage";
import ToolsPage from "@/pages/ToolsPage";
import CachePage from "@/pages/CachePage";
import ActivityPage from "@/pages/ActivityPage";

export default function App() {
  return (
    <FilterProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/cost" element={<CostAnalysisPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/cache" element={<CachePage />} />
          <Route path="/activity" element={<ActivityPage />} />
        </Route>
      </Routes>
    </FilterProvider>
  );
}
