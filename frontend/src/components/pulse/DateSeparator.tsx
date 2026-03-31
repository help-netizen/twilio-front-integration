// Date Separator — per TIMELINE_TECHNICAL_SPECIFICATION.md
// bg-gray-200 text-gray-600 px-4 py-1.5 rounded-full text-xs font-medium shadow-sm

interface DateSeparatorProps {
    date: string;
}

export function DateSeparator({ date }: DateSeparatorProps) {
    return (
        <div className="flex items-center justify-center my-6">
            <div className="px-4 py-1.5 rounded-full text-xs font-medium" style={{ background: 'rgba(118,106,89,0.12)', color: 'var(--blanc-ink-2)', boxShadow: '0 2px 6px rgba(36,31,25,0.06)' }}>
                {date}
            </div>
        </div>
    );
}
