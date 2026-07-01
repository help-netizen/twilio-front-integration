import {
  Dialog, DialogTrigger, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, DialogFooter, Button,
} from 'albusto-ui';

// Open in-card: a confirm dialog — the "cancel job" prompt shape.
export const CancelJob = () => (
  <Dialog defaultOpen>
    <DialogTrigger asChild>
      <Button variant="outline">Cancel job</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel this job?</DialogTitle>
        <DialogDescription>
          Kitchen faucet replacement for Kathy DeCecco, tomorrow 9:00–11:00 AM,
          will be removed from Marcus Bell's schedule. The customer is not notified.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost">Keep job</Button>
        <Button>Cancel job</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

// Open in-card, a second confirm shape (send estimate) so the card still shows a
// live dialog even if one portal cell has trouble in the sheet. The DialogTitle/
// DialogDescription/DialogHeader/DialogFooter primitives require a Dialog root, so
// they must live inside <Dialog>, not standalone.
export const Confirmation = () => (
  <Dialog defaultOpen>
    <DialogTrigger asChild>
      <Button>Send estimate</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Send estimate #1042?</DialogTitle>
        <DialogDescription>
          The estimate will be emailed to Kathy DeCecco with a link to review and approve.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost">Cancel</Button>
        <Button>Send estimate</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
