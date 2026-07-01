import {
  Table, TableHeader, TableBody, TableFooter,
  TableRow, TableHead, TableCell, TableCaption, Badge,
} from 'albusto-ui';

// A real jobs table — the shape used on the Jobs / Leads list pages.
export const JobsTable = () => (
  <Table style={{ maxWidth: 620 }}>
    <TableCaption>Today's scheduled jobs</TableCaption>
    <TableHeader>
      <TableRow>
        <TableHead>Job</TableHead>
        <TableHead>Customer</TableHead>
        <TableHead>Provider</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Kitchen faucet replacement</TableCell>
        <TableCell>Kathy DeCecco</TableCell>
        <TableCell>Marcus Bell</TableCell>
        <TableCell><Badge variant="secondary">Scheduled</Badge></TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Water heater flush</TableCell>
        <TableCell>Louis Tran</TableCell>
        <TableCell>Dana Ruiz</TableCell>
        <TableCell><Badge>In progress</Badge></TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Drain snaking</TableCell>
        <TableCell>Priya Anand</TableCell>
        <TableCell>Marcus Bell</TableCell>
        <TableCell><Badge variant="outline">New</Badge></TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Disposal install</TableCell>
        <TableCell>Greg Halloran</TableCell>
        <TableCell>Dana Ruiz</TableCell>
        <TableCell><Badge variant="outline">Done</Badge></TableCell>
      </TableRow>
    </TableBody>
  </Table>
);

// Compact table with a summary footer — the estimate line-items shape.
export const EstimateItems = () => (
  <Table style={{ maxWidth: 480 }}>
    <TableHeader>
      <TableRow>
        <TableHead>Item</TableHead>
        <TableHead style={{ textAlign: 'right' }}>Amount</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Faucet fixture (Delta)</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$180.00</TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Labor · 2 hrs</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$240.00</TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Supply lines</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$60.00</TableCell>
      </TableRow>
    </TableBody>
    <TableFooter>
      <TableRow>
        <TableCell>Estimate #1042 total</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$480.00</TableCell>
      </TableRow>
    </TableFooter>
  </Table>
);
