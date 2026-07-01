import { Button } from 'albusto-ui';

// Small inline glyph — exercises the `[&_svg]:size-4` icon slot without pulling
// an icon dependency into the preview bundle.
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' };

// The variant axis — one primary action per surface, everything else steps down.
export const Variants = () => (
  <div style={row}>
    <Button>Save changes</Button>
    <Button variant="secondary">Pick time</Button>
    <Button variant="outline">Add item</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="destructive">Delete job</Button>
    <Button variant="link">View details</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Add"><PlusIcon /></Button>
  </div>
);

export const WithIcon = () => (
  <div style={row}>
    <Button><PlusIcon /> New job</Button>
    <Button variant="secondary"><PlusIcon /> Add estimate</Button>
    <Button variant="outline"><PlusIcon /> Attach file</Button>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <Button disabled>Saving…</Button>
    <Button variant="outline" disabled>Unavailable</Button>
  </div>
);
