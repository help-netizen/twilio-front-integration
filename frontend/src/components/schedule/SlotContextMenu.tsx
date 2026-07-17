/**
 * SlotContextMenu — Floating menu shown when user clicks an empty time slot.
 * Offers "Create Job" action with inline title input.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Plus, Briefcase } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { formatTimeInTZ } from '../../utils/companyTime';

interface SlotContextMenuProps {
    /** Pixel position (relative to viewport) */
    anchorRect: { top: number; left: number };
    /** ISO string of slot start in company TZ */
    startAt: string;
    /** ISO string of slot end in company TZ */
    endAt: string;
    timezone: string;
    /** Provider info for timeline views */
    providerId?: string;
    providerName?: string;
    onCreateJob: (title: string) => void;
    onClose: () => void;
}

export const SlotContextMenu: React.FC<SlotContextMenuProps> = ({
    anchorRect, startAt, endAt, timezone, providerId: _providerId, providerName, onCreateJob, onClose,
}) => {
    const [showInput, setShowInput] = useState(false);
    const [title, setTitle] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (showInput && inputRef.current) inputRef.current.focus();
    }, [showInput]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEsc);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEsc);
        };
    }, [onClose]);

    const timeLabel = `${formatTimeInTZ(new Date(startAt), timezone)} – ${formatTimeInTZ(new Date(endAt), timezone)}`;

    const handleSubmit = () => {
        const trimmed = title.trim();
        if (!trimmed) return;
        onCreateJob(trimmed);
        onClose();
    };

    return (
        <div
            ref={containerRef}
            className="fixed z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[220px]"
            style={{
                top: Math.min(anchorRect.top, window.innerHeight - 160),
                left: Math.min(anchorRect.left, window.innerWidth - 240),
            }}
        >
            <div className="px-3 py-1.5 text-[11px] text-gray-400 font-medium">
                {timeLabel}
                {providerName && <span className="ml-1">· {providerName}</span>}
            </div>

            {!showInput ? (
                <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    onClick={() => setShowInput(true)}
                >
                    <Briefcase className="size-4 text-blue-600" />
                    Create Job
                </button>
            ) : (
                <div className="px-3 py-2 space-y-2">
                    <Input
                        ref={inputRef}
                        placeholder="Job title..."
                        className="h-8 text-sm"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') handleSubmit();
                            if (e.key === 'Escape') onClose();
                        }}
                    />
                    <div className="flex gap-1.5">
                        <Button size="sm" className="h-7 text-xs flex-1" onClick={handleSubmit} disabled={!title.trim()}>
                            <Plus className="size-3 mr-1" />
                            Create
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};
