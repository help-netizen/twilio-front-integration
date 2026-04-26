// DateSeparator — chapter-heading style date label (left-aligned, no lines)

interface DateSeparatorProps {
    date: string;
}

/** Format: "Mon, Feb 16" — compact but readable.
 *  Input is the pre-formatted string from PulseTimeline.formatDateSep:
 *  "Today" / "Yesterday" / "Monday, March 30" (no year — TZ-correct already).
 *  We must NOT re-parse via new Date() because year-less strings get pinned
 *  to the engine's fallback year (e.g. 2001) and produce the wrong weekday. */
function compactDate(raw: string): string {
    if (raw === 'Today' || raw === 'Yesterday') return raw;
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length >= 2) {
        const weekday = parts[0].slice(0, 3);
        const rest = parts[1].replace(
            /January|February|March|April|May|June|July|August|September|October|November|December/,
            m => m.slice(0, 3)
        );
        return `${weekday}, ${rest}`;
    }
    return raw;
}

export function DateSeparator({ date }: DateSeparatorProps) {
    return (
        <div className="px-5 pt-6 pb-2">
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
