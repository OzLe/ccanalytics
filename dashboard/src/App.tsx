import { Routes, Route, useNavigate } from "react-router-dom";
import { FilterProvider } from "@/hooks/useFilters";
import Layout from "@/components/layout/Layout";
import DashboardPage from "@/pages/DashboardPage";
import CostAnalysisPage from "@/pages/CostAnalysisPage";
import SessionsPage from "@/pages/SessionsPage";
import SessionDetailPage from "@/pages/SessionDetailPage";
import ToolsPage from "@/pages/ToolsPage";
import SkillsPage from "@/pages/SkillsPage";
import CachePage from "@/pages/CachePage";
import ActivityPage from "@/pages/ActivityPage";
import PromptsPage from "@/pages/PromptsPage";
import SettingsPage from "@/pages/SettingsPage";
import EmptyState from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";

function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Page not found"
      message="The page you're looking for doesn't exist or has been moved."
    >
      <Button variant="secondary" onClick={() => navigate('/')}>
        Back to Dashboard
      </Button>
    </EmptyState>
  );
}

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
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/cache" element={<CachePage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </FilterProvider>
  );
}
