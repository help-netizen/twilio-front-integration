// DateSeparator — divides timeline by date with flanking horizontal rules

interface DateSeparatorProps {
    date: string;
}

/** Format: "Mon, Feb 16" — compact but readable */
function compactDate(raw: string): string {
    // raw is already formatted by PulseTimeline: "Today" | "Yesterday" | "Monday, February 16, ..."
    if (raw === 'Today' || raw === 'Yesterday') return raw;
    // Parse and reformat to "Mon, Feb 16"
    try {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }
    } catch { /* ignore */ }
    // Fallback: take first two comma-separated parts of the long format
    // e.g. "Monday, February 16" → "Mon, Feb 16"
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length >= 2) {
        const weekday = parts[0].slice(0, 3);
        const rest = parts[1];
        // Abbreviate month: "February 16" → "Feb 16"
        const abbreviated = rest.replace(
            /January|February|March|April|May|June|July|August|September|October|November|December/,
            m => m.slice(0, 3)
        );
        return `${weekday}, ${abbreviated}`;
    }
    return raw;
}

export function DateSeparator({ date }: DateSeparatorProps) {
    return (
        <div className="flex items-center gap-3 my-5 px-4">
            <div className="flex-1 h-px" style={{ background: 'var(--blanc-line)' }} />
            <span
                className="shrink-0 text-[11px] font-semibold tracking-wide uppercase"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
            >
                {compactDate(date)}
            </span>
            <div className="flex-1 h-px" style={{ background: 'var(--blanc-line)' }} />
        </div>
    );
}
