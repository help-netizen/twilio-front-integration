import { Separator } from 'albusto-ui';

const dim: React.CSSProperties = { color: 'var(--blanc-ink-3)', fontSize: 11 };
const eyebrow: React.CSSProperties = {
  color: 'var(--blanc-ink-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
};

// Horizontal — divides two stacked blocks on a job detail panel.
export const Horizontal = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 340 }}>
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontWeight: 600 }}>Kitchen faucet replacement</span>
      <span style={dim}>Tomorrow, 9:00–11:00 AM · Marcus Bell</span>
    </div>
    <Separator />
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={eyebrow}>Customer</span>
      <span>Kathy DeCecco · 18 Maple St, Newton</span>
    </div>
  </div>
);

// Vertical — separates inline meta items in a single row.
export const Vertical = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 20 }}>
    <span>Estimate #1042</span>
    <Separator orientation="vertical" />
    <span style={dim}>$480.00</span>
    <Separator orientation="vertical" />
    <span style={dim}>Sent</span>
  </div>
);
