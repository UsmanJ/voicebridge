import { type DisplayStatus, STATUS_LABEL } from '../status';

export function StatusIndicator({ status }: { status: DisplayStatus }) {
  return (
    <p className="status" data-status={status} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span className="visually-hidden">Assistant status: </span>
      {STATUS_LABEL[status]}
    </p>
  );
}
