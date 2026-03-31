/**
 * ScheduleToolbar — Simplified: "Schedule" title + AI Assistant button.
 * Sprint 7 Design Refresh: view/date/filter controls moved to CalendarControls.
 */

import React from 'react';
import { Sparkles } from 'lucide-react';

interface ScheduleToolbarProps {
    onToggleAIAssistant?: () => void;
}

export const ScheduleToolbar: React.FC<ScheduleToolbarProps> = ({ onToggleAIAssistant }) => {
    return (
        <div className="flex items-center justify-between gap-4 px-1">
            <h1
                className="leading-none font-bold"
                style={{
                    fontFamily: 'Manrope, sans-serif',
                    fontSize: 'clamp(34px, 4vw, 44px)',
                    letterSpacing: '-0.05em',
                    color: 'var(--sched-ink-1)',
                    margin: 0,
                }}
            >
                Schedule
            </h1>

            {onToggleAIAssistant && (
                <button
                    type="button"
                    onClick={onToggleAIAssistant}
                    className="flex items-center gap-2.5 min-h-[48px] px-5 text-[15px] font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                        background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.95), rgba(99, 102, 241, 0.95))',
                        border: '1px solid rgba(255, 255, 255, 0.25)',
                        borderRadius: 'var(--sched-radius-md)',
                        color: '#ffffff',
                        boxShadow: '0 8px 24px rgba(99, 102, 241, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                    }}
                >
                    <Sparkles className="size-5" />
                    <span>AI Assistant</span>
                </button>
            )}
        </div>
    );
};
