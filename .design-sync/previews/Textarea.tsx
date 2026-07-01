import { Textarea, Label } from 'albusto-ui';

const field: React.CSSProperties = { display: 'grid', gap: 6, maxWidth: 380 };
const hint: React.CSSProperties = { color: 'var(--blanc-ink-3)', fontSize: 11 };

// The real Albusto pattern — a note typed inline on a job card, saved on blur.
export const NoteField = () => (
  <div style={field}>
    <Label htmlFor="job-note">Note</Label>
    <Textarea
      id="job-note"
      defaultValue="Customer asked us to text 30 min before arrival. Gate code 4417 — dog is friendly but keep the side door shut."
      rows={4}
    />
    <span style={hint}>Saves automatically when you click away.</span>
  </div>
);

// Empty vs disabled, side by side.
export const States = () => (
  <div style={{ display: 'grid', gap: 16 }}>
    <div style={field}>
      <Label htmlFor="est-terms">Estimate terms</Label>
      <Textarea id="est-terms" placeholder="Add scope, exclusions, or payment terms for estimate #1042…" rows={3} />
    </div>
    <div style={field}>
      <Label htmlFor="job-desc">Job description</Label>
      <Textarea
        id="job-desc"
        defaultValue="Replace kitchen faucet, supply lines, and shutoff valves under sink."
        rows={2}
        disabled
      />
    </div>
  </div>
);
