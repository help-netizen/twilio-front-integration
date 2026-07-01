import { Input, Label } from 'albusto-ui';

const field: React.CSSProperties = { display: 'grid', gap: 6, maxWidth: 320 };
const hint: React.CSSProperties = { color: 'var(--blanc-ink-3)', fontSize: 11 };

// A labeled field is how Input always appears in Albusto forms (new job / new lead).
export const Field = () => (
  <div style={field}>
    <Label htmlFor="cust-name">Customer name</Label>
    <Input id="cust-name" defaultValue="Kathy DeCecco" />
  </div>
);

// The value axis — placeholder (empty) vs filled vs a typed field with a helper line.
export const States = () => (
  <div style={{ display: 'grid', gap: 16 }}>
    <div style={field}>
      <Label htmlFor="job-addr">Service address</Label>
      <Input id="job-addr" placeholder="18 Maple St, Newton" />
    </div>
    <div style={field}>
      <Label htmlFor="job-phone">Phone</Label>
      <Input id="job-phone" type="tel" defaultValue="(617) 555-0142" />
      <span style={hint}>Used for job reminders and arrival texts.</span>
    </div>
  </div>
);

// Disabled — a read-only field that can't be edited on this screen.
export const Disabled = () => (
  <div style={field}>
    <Label htmlFor="est-num">Estimate number</Label>
    <Input id="est-num" defaultValue="#1042" disabled />
  </div>
);
