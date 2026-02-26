import React from "react";
import { AlertTriangle } from "lucide-react";
import EmptyState from "./EmptyState";
import { Button } from "./Button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <EmptyState
          icon={AlertTriangle}
          title="Something went wrong"
          message={
            this.state.error?.message ??
            "An unexpected error occurred while rendering this section."
          }
        >
          <Button variant="primary" size="md" onClick={this.handleRetry}>
            Retry
          </Button>
        </EmptyState>
      );
    }

    return this.props.children;
  }
}
