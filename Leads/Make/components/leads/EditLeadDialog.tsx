import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner@2.0.3';
import { mockLeadsAPI } from '../../lib/mock-api';
import type { Lead, UpdateLeadInput } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';

interface EditLeadDialogProps {
  lead: Lead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (lead: Lead) => void;
}

const JOB_TYPES = [
  { value: 'COD', label: 'COD Call of Demand' },
  { value: 'INS', label: 'INS Insurance' },
  { value: 'RUW', label: 'Recall under Warranty' },
];

const JOB_SOURCES = [
  'eLocals',
  'Inquirly',
  'Servicedirect',
  'ProReferral',
  'Google',
  'Thumbtack',
  'Yelp',
];

const US_STATES = ['NY', 'CA', 'IL', 'TX', 'AZ', 'PA', 'FL', 'OH', 'NC', 'GA'];

export function EditLeadDialog({ lead, open, onOpenChange, onSuccess }: EditLeadDialogProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<UpdateLeadInput>({
    UUID: lead.UUID,
    FirstName: lead.FirstName,
    LastName: lead.LastName,
    Phone: lead.Phone,
    Email: lead.Email || '',
    Company: lead.Company || '',
    Address: lead.Address || '',
    City: lead.City || '',
    State: lead.State || '',
    PostalCode: lead.PostalCode || '',
    JobType: lead.JobType || '',
    JobSource: lead.JobSource || '',
    LeadNotes: lead.LeadNotes || '',
    Status: lead.Status,
  });

  // Update form when lead changes
  useEffect(() => {
    setFormData({
      UUID: lead.UUID,
      FirstName: lead.FirstName,
      LastName: lead.LastName,
      Phone: lead.Phone,
      Email: lead.Email || '',
      Company: lead.Company || '',
      Address: lead.Address || '',
      City: lead.City || '',
      State: lead.State || '',
      PostalCode: lead.PostalCode || '',
      JobType: lead.JobType || '',
      JobSource: lead.JobSource || '',
      LeadNotes: lead.LeadNotes || '',
      Status: lead.Status,
    });
  }, [lead]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.FirstName || !formData.LastName || !formData.Phone) {
      toast.error('Please fill in required fields');
      return;
    }

    setLoading(true);
    try {
      const updatedLead = await mockLeadsAPI.update(formData);
      onSuccess(updatedLead);
    } catch (error) {
      toast.error('Failed to update lead', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Lead - {lead.SerialId}</DialogTitle>
          <DialogDescription>
            Make changes to the lead details below.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Status */}
          <div>
            <Label htmlFor="status" className="mb-2">Status</Label>
            <Select
              value={formData.Status}
              onValueChange={(value) => setFormData({ ...formData, Status: value })}
            >
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Contact Information */}
          <div className="space-y-4">
            <h3 className="font-medium">Contact Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="firstName" className="mb-2">
                  First Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="firstName"
                  value={formData.FirstName}
                  onChange={(e) => setFormData({ ...formData, FirstName: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="lastName" className="mb-2">
                  Last Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="lastName"
                  value={formData.LastName}
                  onChange={(e) => setFormData({ ...formData, LastName: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="phone" className="mb-2">
                  Phone <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.Phone}
                  onChange={(e) => setFormData({ ...formData, Phone: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="email" className="mb-2">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.Email}
                  onChange={(e) => setFormData({ ...formData, Email: e.target.value })}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="company" className="mb-2">Company</Label>
              <Input
                id="company"
                value={formData.Company}
                onChange={(e) => setFormData({ ...formData, Company: e.target.value })}
              />
            </div>
          </div>

          {/* Address */}
          <div className="space-y-4">
            <h3 className="font-medium">Address</h3>
            <div>
              <Label htmlFor="address" className="mb-2">Street Address</Label>
              <Input
                id="address"
                value={formData.Address}
                onChange={(e) => setFormData({ ...formData, Address: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="city" className="mb-2">City</Label>
                <Input
                  id="city"
                  value={formData.City}
                  onChange={(e) => setFormData({ ...formData, City: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="state" className="mb-2">State</Label>
                <Select
                  value={formData.State}
                  onValueChange={(value) => setFormData({ ...formData, State: value })}
                >
                  <SelectTrigger id="state">
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent>
                    {US_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {state}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="postalCode" className="mb-2">Postal Code</Label>
                <Input
                  id="postalCode"
                  value={formData.PostalCode}
                  onChange={(e) => setFormData({ ...formData, PostalCode: e.target.value })}
                />
              </div>
            </div>
          </div>

          {/* Job Details */}
          <div className="space-y-4">
            <h3 className="font-medium">Job Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="jobType" className="mb-2">Job Type</Label>
                <Select
                  value={formData.JobType}
                  onValueChange={(value) => setFormData({ ...formData, JobType: value })}
                >
                  <SelectTrigger id="jobType">
                    <SelectValue placeholder="Select job type" />
                  </SelectTrigger>
                  <SelectContent>
                    {JOB_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="jobSource" className="mb-2">Job Source</Label>
                <Select
                  value={formData.JobSource}
                  onValueChange={(value) => setFormData({ ...formData, JobSource: value })}
                >
                  <SelectTrigger id="jobSource">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {JOB_SOURCES.map((source) => (
                      <SelectItem key={source} value={source}>
                        {source}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor="leadNotes" className="mb-2">Description</Label>
              <Textarea
                id="leadNotes"
                value={formData.LeadNotes}
                onChange={(e) => setFormData({ ...formData, LeadNotes: e.target.value })}
                rows={4}
                className="min-h-[80px] resize-y"
                placeholder="Enter job description..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}