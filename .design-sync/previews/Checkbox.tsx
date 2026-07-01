import { Checkbox, Label } from 'albusto-ui';

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const Row = ({ children }: { children: React.ReactNode }) => <div style={rowStyle}>{children}</div>;

// Checkbox is always a labeled control — an estimate line-item's taxable toggle.
export const LabeledRow = () => (
  <Row>
    <Checkbox id="li-taxable" defaultChecked />
    <Label htmlFor="li-taxable">Taxable</Label>
  </Row>
);

// The state axis — checked vs unchecked in a real settings group.
export const States = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
    <Row>
      <Checkbox id="notify-sms" defaultChecked />
      <Label htmlFor="notify-sms">Text customer when tech is en route</Label>
    </Row>
    <Row>
      <Checkbox id="notify-email" />
      <Label htmlFor="notify-email">Email a copy of the invoice</Label>
    </Row>
    <Row>
      <Checkbox id="notify-review" />
      <Label htmlFor="notify-review">Request a review after the job is done</Label>
    </Row>
  </div>
);

// Disabled — a locked option that can't be changed on this plan.
export const Disabled = () => (
  <div style={{ display: 'grid', gap: 12 }}>
    <Row>
      <Checkbox id="lock-on" defaultChecked disabled />
      <Label htmlFor="lock-on">Collect payment online</Label>
    </Row>
    <Row>
      <Checkbox id="lock-off" disabled />
      <Label htmlFor="lock-off">Auto-charge card on file</Label>
    </Row>
  </div>
);
