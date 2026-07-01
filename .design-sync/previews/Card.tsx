import {
  Card, CardHeader, CardTitle, CardDescription, CardAction,
  CardContent, CardFooter, Button, Badge,
} from 'albusto-ui';

const dim: React.CSSProperties = { color: 'var(--blanc-ink-3)' };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16 };

// Compound composition + a lot of type — the card is how Albusto frames a job,
// so it doubles as the typography canary (heading font vs body font vs muted).
export const JobCard = () => (
  <Card style={{ maxWidth: 420 }}>
    <CardHeader>
      <CardTitle>Kitchen faucet replacement</CardTitle>
      <CardDescription>Standard service · Tomorrow, 9:00–11:00 AM</CardDescription>
      <CardAction>
        <Badge variant="secondary">Scheduled</Badge>
      </CardAction>
    </CardHeader>
    <CardContent style={{ display: 'grid', gap: 8 }}>
      <div style={row}><span style={dim}>Customer</span><span>Kathy DeCecco</span></div>
      <div style={row}><span style={dim}>Address</span><span>18 Maple St, Newton</span></div>
      <div style={row}><span style={dim}>Provider</span><span>Marcus Bell</span></div>
    </CardContent>
    <CardFooter style={{ gap: 8 }}>
      <Button size="sm">Start job</Button>
      <Button size="sm" variant="ghost">Reschedule</Button>
    </CardFooter>
  </Card>
);

export const Notice = () => (
  <Card style={{ maxWidth: 360 }}>
    <CardHeader>
      <CardTitle>Estimate sent</CardTitle>
      <CardDescription>Estimate #1042 was emailed to the customer.</CardDescription>
    </CardHeader>
    <CardContent>
      <p style={{ margin: 0, color: 'var(--blanc-ink-2)' }}>
        You'll be notified here as soon as Kathy opens or approves it — no need to follow up by phone.
      </p>
    </CardContent>
  </Card>
);
