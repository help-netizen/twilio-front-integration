import { Switch, Label } from 'albusto-ui';

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 16, maxWidth: 320,
};
const Row = ({ children }: { children: React.ReactNode }) => <div style={rowStyle}>{children}</div>;

// Switch is a labeled toggle — the real "Only Open" filter on a contact's Leads & Jobs.
export const LabeledRow = () => (
  <Row>
    <Label htmlFor="only-open">Only open</Label>
    <Switch id="only-open" defaultChecked />
  </Row>
);

// The state axis — on vs off in a settings list.
export const States = () => (
  <div style={{ display: 'grid', gap: 14 }}>
    <Row>
      <Label htmlFor="sw-sync">Sync jobs with Zenbooker</Label>
      <Switch id="sw-sync" defaultChecked />
    </Row>
    <Row>
      <Label htmlFor="sw-slots">Show recommended time slots</Label>
      <Switch id="sw-slots" />
    </Row>
    <Row>
      <Label htmlFor="sw-online">Accept online payments</Label>
      <Switch id="sw-online" defaultChecked />
    </Row>
  </div>
);

// Disabled — a toggle locked on this account.
export const Disabled = () => (
  <div style={{ display: 'grid', gap: 14 }}>
    <Row>
      <Label htmlFor="sw-lock-on">After-hours auto-reply</Label>
      <Switch id="sw-lock-on" defaultChecked disabled />
    </Row>
    <Row>
      <Label htmlFor="sw-lock-off">Route calls to Sara</Label>
      <Switch id="sw-lock-off" disabled />
    </Row>
  </div>
);
