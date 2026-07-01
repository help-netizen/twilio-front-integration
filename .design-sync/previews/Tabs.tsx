import {
  Tabs, TabsList, TabsTrigger, TabsContent, Badge,
} from 'albusto-ui';

const dim: React.CSSProperties = { color: 'var(--blanc-ink-3)' };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16 };

// The canonical detail-panel pattern: a tabbed body over one job.
// Details tab is active so real content is visible under the tab strip.
export const JobPanel = () => (
  <Tabs defaultValue="details" style={{ maxWidth: 440 }}>
    <TabsList>
      <TabsTrigger value="details">Details</TabsTrigger>
      <TabsTrigger value="notes">Notes</TabsTrigger>
      <TabsTrigger value="history">History</TabsTrigger>
    </TabsList>
    <TabsContent value="details" style={{ display: 'grid', gap: 8, paddingTop: 4 }}>
      <div style={row}><span style={dim}>Customer</span><span>Kathy DeCecco</span></div>
      <div style={row}><span style={dim}>Address</span><span>18 Maple St, Newton</span></div>
      <div style={row}><span style={dim}>Provider</span><span>Marcus Bell</span></div>
      <div style={row}>
        <span style={dim}>Status</span>
        <Badge variant="secondary">Scheduled</Badge>
      </div>
    </TabsContent>
    <TabsContent value="notes">Called ahead — access via side gate.</TabsContent>
    <TabsContent value="history">Created 2 days ago · Rescheduled once</TabsContent>
  </Tabs>
);

// Two-tab form split (Details | Finance), the shape used on the lead panel.
export const FinanceSplit = () => (
  <Tabs defaultValue="finance" style={{ maxWidth: 380 }}>
    <TabsList>
      <TabsTrigger value="details">Details</TabsTrigger>
      <TabsTrigger value="finance">Finance</TabsTrigger>
    </TabsList>
    <TabsContent value="details" style={{ paddingTop: 4 }}>
      Kitchen faucet replacement · Standard service
    </TabsContent>
    <TabsContent value="finance" style={{ display: 'grid', gap: 8, paddingTop: 4 }}>
      <div style={row}><span style={dim}>Estimate #1042</span><span>$480.00</span></div>
      <div style={row}><span style={dim}>Deposit</span><span>$120.00</span></div>
      <div style={row}><span style={dim}>Balance due</span><span>$360.00</span></div>
    </TabsContent>
  </Tabs>
);
