/**
 * ScheduleToolbar — Simplified: "Schedule" title + AI Assistant button.
 * Sprint 7 Design Refresh: view/date/filter controls moved to CalendarControls.
 */

import React from 'react';
import { Sparkles, Plus } from 'lucide-react';
import { Button } from '../ui/button';

interface ScheduleToolbarProps {
    onToggleAIAssistant?: () => void;
    onNewJob?: () => void;
}

export const ScheduleToolbar: React.FC<ScheduleToolbarProps> = ({ onToggleAIAssistant, onNewJob }) => {
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

            <div className="flex items-center gap-3">
            {onNewJob && (
                <Button type="button" onClick={onNewJob} className="h-[48px] gap-2 px-5 text-[15px] rounded-[var(--sched-radius-md)]">
                    <Plus className="size-5" /> New job
                </Button>
            )}
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
        </div>
    );
};
