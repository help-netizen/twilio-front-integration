import { Badge } from 'albusto-ui';

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const dim: React.CSSProperties = { color: 'var(--blanc-ink-3)', fontSize: 11 };

// Small status glyph — exercises the [&>svg]:size-3 slot without an icon dependency.
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// The variant axis — how Albusto tags a job/estimate/invoice state.
export const Variants = () => (
  <div style={row}>
    <Badge>New</Badge>
    <Badge variant="secondary">Scheduled</Badge>
    <Badge variant="destructive">Overdue</Badge>
    <Badge variant="outline">Draft</Badge>
  </div>
);

// How statuses actually read on a detail panel — worded labels, outline for side-tags.
export const JobStatuses = () => (
  <div style={{ display: 'grid', gap: 10 }}>
    <div style={row}>
      <Badge variant="secondary">In progress</Badge>
      <Badge variant="outline">Estimate #1042</Badge>
      <Badge variant="outline">Taxable</Badge>
    </div>
    <div style={row}>
      <Badge><CheckIcon /> Paid</Badge>
      <Badge variant="destructive">Cancelled</Badge>
      <Badge variant="outline">Archived</Badge>
    </div>
  </div>
);

// Inline in a list row, next to real content.
export const InContext = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, maxWidth: 360 }}>
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontWeight: 600 }}>Kitchen faucet replacement</span>
      <span style={dim}>Kathy DeCecco · 18 Maple St, Newton</span>
    </div>
    <Badge variant="secondary">Done</Badge>
  </div>
);
