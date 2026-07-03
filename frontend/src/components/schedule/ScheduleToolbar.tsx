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
            {/* PALETTE-V2: оба хедер-действия = канонный pill одной высоты; New job —
                solid primary (ui/button default = --blanc-accent), AI Assistant остаётся
                фиолетовым, но без кастомного градиента/теней. */}
            {onNewJob && (
                <Button type="button" onClick={onNewJob} className="h-[48px] gap-2 px-6 text-[15px]">
                    <Plus className="size-5" /> New job
                </Button>
            )}
            {onToggleAIAssistant && (
                <Button
                    type="button"
                    variant="secondary"
                    onClick={onToggleAIAssistant}
                    className="h-[48px] gap-2.5 px-6 text-[15px] font-semibold"
                >
                    <Sparkles className="size-5" />
                    <span>AI Assistant</span>
                </Button>
            )}
            </div>
        </div>
    );
};
