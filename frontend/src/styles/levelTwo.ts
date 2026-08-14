/**
 * Level two — the type below a section heading.
 *
 * One family, one size, one weight for a field group's heading, its labels and
 * its values alike; grey names a thing, black answers it. The CSS twins live in
 * design-system.css as `.blanc-l2` / `.blanc-l2-quiet` — these objects are for
 * the places that style through a React style prop, and must stay in step.
 */
export const LEVEL_TWO: React.CSSProperties = {
    fontFamily: 'var(--blanc-font-body)',
    fontSize: '15px',
    fontWeight: 500,
    lineHeight: '20px',
    letterSpacing: '0.005em',
};

/** What a value is called. The only difference from the value itself. */
export const LEVEL_TWO_QUIET: React.CSSProperties = {
    ...LEVEL_TWO,
    color: 'var(--blanc-ink-3)',
};

/**
 * What a GROUP of values is called — Contact, Schedule, Location, Provider.
 * Black and bold so the eye finds it at a glance, and deliberately the same
 * size as the rows beneath: weight and colour make it a heading.
 */
export const LEVEL_TWO_HEADING: React.CSSProperties = {
    ...LEVEL_TWO,
    color: 'var(--blanc-ink-1)',
    fontWeight: 600,
};

/** Width of the label column, sized for the longest label we use ("Customer"). */
export const LEVEL_TWO_LABEL_WIDTH = 84;
