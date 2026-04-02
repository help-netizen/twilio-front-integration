// DateSeparator — chapter-heading style date label (left-aligned, no lines)

interface DateSeparatorProps {
    date: string;
}

/** Format: "Mon, Feb 16" — compact but readable */
function compactDate(raw: string): string {
    if (raw === 'Today' || raw === 'Yesterday') return raw;
    try {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }
    } catch { /* ignore */ }
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length >= 2) {
        const weekday = parts[0].slice(0, 3);
        const rest = parts[1];
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
        <div className="px-4 pt-6 pb-2">
            <h3
                className="text-base font-bold"
                style={{
                    color: 'var(--blanc-ink-1)',
                    fontFamily: 'var(--blanc-font-heading)',
                    letterSpacing: '-0.01em',
                }}
            >
                {compactDate(date)}
            </h3>
        </div>
    );
}
