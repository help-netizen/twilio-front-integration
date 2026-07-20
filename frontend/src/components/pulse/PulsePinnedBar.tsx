import React from 'react';
import { ChevronDown } from 'lucide-react';

interface PulsePinnedBarProps extends React.HTMLAttributes<HTMLElement> {
    entityLabel: string;
    accent: string;
}

/**
 * Shared geometry for the pinned Contact and Lead bars.
 * Entity components own their grid tracks and content-specific degradation.
 */
export function PulsePinnedBar({ entityLabel, accent, className = '', style, children, ...props }: PulsePinnedBarProps) {
    return (
        <section
            {...props}
            aria-label={entityLabel}
            className={['pulse-card', 'pulse-pinned-bar', className].filter(Boolean).join(' ')}
            style={{ ...style, '--pulse-pinned-bar-accent': accent } as React.CSSProperties}
        >
            {children}
        </section>
    );
}

export interface PulsePinnedBarActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    label: string;
    icon: React.ReactNode;
    showLabel?: boolean;
}

export const PulsePinnedBarAction = React.forwardRef<HTMLButtonElement, PulsePinnedBarActionProps>(
    ({ label, icon, showLabel = true, className = '', title, ...props }, ref) => (
        <button
            {...props}
            ref={ref}
            type={props.type || 'button'}
            className={['pulse-pinned-bar-action', showLabel ? '' : 'is-icon-only', className].filter(Boolean).join(' ')}
            aria-label={props['aria-label'] || label}
            title={title || label}
        >
            {icon}
            {showLabel && <span className="pulse-pinned-bar-action-label">{label}</span>}
        </button>
    ),
);
PulsePinnedBarAction.displayName = 'PulsePinnedBarAction';

export function PulsePinnedBarExpand({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <PulsePinnedBarAction
            className="pulse-pinned-bar-expand"
            label={label}
            icon={<ChevronDown aria-hidden />}
            showLabel={false}
            onClick={onClick}
        />
    );
}
