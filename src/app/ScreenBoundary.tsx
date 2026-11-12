import { useTranslation } from 'react-i18next';
import { Component } from 'react';
import type { ReactNode } from 'react';
import { AppStatus } from './AppStatus';

interface ScreenBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly onBack?: () => void;
  readonly backLabel?: string;
  readonly failureMessage?: string;
  readonly fallback?: ReactNode;
}

interface ScreenBoundaryState {
  readonly failed: boolean;
}

function LoadFailure({ onBack, backLabel, failureMessage }: Pick<ScreenBoundaryProps, 'onBack' | 'backLabel' | 'failureMessage'>) {
  const { t } = useTranslation('common');
  return <AppStatus role="alert" message={failureMessage ?? t(($) => $.screenLoadFailed)}
    onRetry={() => window.location.reload()} retryLabel={t(($) => $.reload)}
    onBack={onBack} backLabel={backLabel} />;
}

export class ScreenBoundary extends Component<ScreenBoundaryProps, ScreenBoundaryState> {
  state: ScreenBoundaryState = { failed: false };

  static getDerivedStateFromError(): ScreenBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: ScreenBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return <LoadFailure onBack={this.props.onBack} backLabel={this.props.backLabel}
        failureMessage={this.props.failureMessage} />;
    }
    return this.props.children;
  }
}
