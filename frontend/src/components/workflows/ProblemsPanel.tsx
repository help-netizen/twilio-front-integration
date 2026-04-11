import { useState } from 'react';
import { XCircle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

export interface ProblemItem {
  message: string;
  line?: number;
  col?: number;
  severity: string;
}

export interface ProblemsPanelProps {
  errors: ProblemItem[];
  warnings: ProblemItem[];
  onProblemClick?: (line: number, col: number) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function ProblemsPanel({
  errors,
  warnings,
  onProblemClick,
  collapsed: controlledCollapsed,
  onToggleCollapse,
}: ProblemsPanelProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const isControlled = controlledCollapsed !== undefined;
  const collapsed = isControlled ? controlledCollapsed : internalCollapsed;

  const handleToggle = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed((prev) => !prev);
    }
  };

  const total = errors.length + warnings.length;
  if (total === 0) return null;

  const Chevron = collapsed ? ChevronRight : ChevronDown;

  const summaryParts: string[] = [];
  if (errors.length > 0) summaryParts.push(`${errors.length} error${errors.length !== 1 ? 's' : ''}`);
  if (warnings.length > 0) summaryParts.push(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`);

  return (
    <div>
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full text-left blanc-eyebrow mb-2 cursor-pointer select-none hover:text-[var(--blanc-ink-2)] transition-colors"
      >
        <Chevron className="w-3 h-3" />
        <span>Problems</span>
        <span className="ml-1 text-[var(--blanc-ink-3)] normal-case tracking-normal">
          ({summaryParts.join(', ')})
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-1.5">
          {errors.map((err, i) => (
            <button
              key={`err-${i}`}
              type="button"
              onClick={() => err.line != null && onProblemClick?.(err.line, err.col ?? 1)}
              disabled={err.line == null}
              className="flex items-start gap-2 text-xs text-red-600 rounded-lg bg-red-50 px-3 py-2 w-full text-left
                disabled:cursor-default enabled:cursor-pointer enabled:hover:bg-red-100 transition-colors"
            >
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">
                {err.message}
              </span>
              {err.line != null && (
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-500 shrink-0">
                  Line {err.line}{err.col != null ? `:${err.col}` : ''}
                </span>
              )}
            </button>
          ))}
          {warnings.map((warn, i) => (
            <button
              key={`warn-${i}`}
              type="button"
              onClick={() => warn.line != null && onProblemClick?.(warn.line, warn.col ?? 1)}
              disabled={warn.line == null}
              className="flex items-start gap-2 text-xs text-yellow-700 rounded-lg bg-yellow-50 px-3 py-2 w-full text-left
                disabled:cursor-default enabled:cursor-pointer enabled:hover:bg-yellow-100 transition-colors"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">
                {warn.message}
              </span>
              {warn.line != null && (
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-600 shrink-0">
                  Line {warn.line}{warn.col != null ? `:${warn.col}` : ''}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
