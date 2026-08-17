import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui/button";

interface Props {
  /** Named so the message can say which screen failed rather than "something". */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Tabs stay mounted once opened (see `Pane` in App.tsx), so without a boundary per pane
 * a throw anywhere unmounts the entire tree — the owner loses the inbox because the
 * diary rendered a bad date. One boundary around each pane keeps the failure the size
 * of the screen it happened on.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // There is no browser error reporter, and inventing one here would send customer
    // data to a third party. The console is what a support call can actually ask for.
    console.error(`${this.props.label} failed to render`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-start gap-3 p-8">
        <p className="text-sm font-medium">{this.props.label} could not be displayed.</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          The rest of the dashboard is still working — the other tabs are unaffected. If
          this keeps happening, send us the message below.
        </p>
        <code className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-xs">
          {this.state.error.message}
        </code>
        <div className="flex gap-2">
          {/* Remounts the subtree. Worth offering before a reload, because a failure
              caused by one bad row usually clears once the screen refetches. */}
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      </div>
    );
  }
}
