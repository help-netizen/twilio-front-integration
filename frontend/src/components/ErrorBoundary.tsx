import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
    children: ReactNode;
    /** Rendered instead of the children after a render/runtime error below. */
    fallback?: ReactNode;
    /** Optional hook for logging/telemetry. */
    onError?: (error: Error, info: ErrorInfo) => void;
    /** When this value changes, the boundary clears its error and retries. */
    resetKey?: unknown;
}

interface ErrorBoundaryState {
    hasError: boolean;
}

/**
 * Contains a subtree so a runtime error inside it (e.g. a third-party script like
 * Google Maps throwing during render) renders a small fallback instead of
 * unmounting the whole page. Reset by changing `resetKey`.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        this.props.onError?.(error, info);
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    componentDidUpdate(prevProps: ErrorBoundaryProps): void {
        if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ hasError: false });
        }
    }

    render(): ReactNode {
        if (this.state.hasError) return this.props.fallback ?? null;
        return this.props.children;
    }
}
