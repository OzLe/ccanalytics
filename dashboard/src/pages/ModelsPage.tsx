import EmptyState from "@/components/ui/EmptyState";
import { Cpu } from "lucide-react";

export default function ModelsPage() {
  return (
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
      <EmptyState
        icon={Cpu}
        title="Models"
        message="Models comparison is under development. Visit the Cost Analysis page to see cost breakdown by model."
      />
    </div>
  );
}
