import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import React from "react";

export type Period = "today" | "7d" | "30d" | "90d" | "all";

export interface Filters {
  period: Period;
  model: string | null;
  project: string | null;
  source: string | null;
}

interface FiltersContextValue {
  filters: Filters;
  setPeriod: (period: Period) => void;
  setModel: (model: string | null) => void;
  setProject: (project: string | null) => void;
  setSource: (source: string | null) => void;
  resetFilters: () => void;
}

const defaultFilters: Filters = {
  period: "7d",
  model: null,
  project: null,
  source: null,
};

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);

  const setPeriod = useCallback((period: Period) => {
    setFilters((prev) => ({ ...prev, period }));
  }, []);

  const setModel = useCallback((model: string | null) => {
    setFilters((prev) => ({ ...prev, model }));
  }, []);

  const setProject = useCallback((project: string | null) => {
    setFilters((prev) => ({ ...prev, project }));
  }, []);

  const setSource = useCallback((source: string | null) => {
    setFilters((prev) => ({ ...prev, source }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(defaultFilters);
  }, []);

  const value = useMemo<FiltersContextValue>(
    () => ({ filters, setPeriod, setModel, setProject, setSource, resetFilters }),
    [filters, setPeriod, setModel, setProject, setSource, resetFilters],
  );

  return React.createElement(FiltersContext.Provider, { value }, children);
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) {
    throw new Error("useFilters must be used within a FilterProvider");
  }
  return ctx;
}
