import { useState } from 'react';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { Dialog, DialogContent, DialogDescription, DialogPanelFooter, DialogPanelHeader, DialogBody, DialogTitle } from '../ui/dialog';
import { toast } from 'sonner';
import { authedFetch } from '../../services/apiClient';

interface BootstrapAdminDialogProps {
    companyId: string | null;
    companyName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

export function BootstrapAdminDialog({ companyId, companyName, open, onOpenChange, onSuccess }: BootstrapAdminDialogProps) {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        email: '',
        first_name: '',
        last_name: '',
    });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!companyId) return;
        setLoading(true);

        try {
            const res = await authedFetch(`/api/admin/companies/${companyId}/bootstrap-admin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            if (res.ok) {
                toast.success('Admin added');
                setFormData({ email: '', first_name: '', last_name: '' });
                onSuccess();
                onOpenChange(false);
            } else {
                const data = await res.json();
                toast.error('Failed to bootstrap admin', { description: data.error });
            }
        } catch (err: any) {
            toast.error('Connection error', { description: err.message });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <form onSubmit={handleSubmit} className="contents">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Add first admin
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            Invite the first user for {companyName}. They will receive an email to set their password and will be made an administrator.
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-[15px]" style={{ color: 'var(--blanc-ink-2)' }}>
                            Invite the first user for <strong>{companyName}</strong>. They will receive an email to set their password and will be made an administrator.
                        </p>
                        <div className="space-y-3.5">
                            <FloatingField id="email" name="email" label="Email Address" type="email" value={formData.email} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="first_name" name="first_name" label="First Name" value={formData.first_name} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                                <FloatingField id="last_name" name="last_name" label="Last Name" value={formData.last_name} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                            </div>
                        </div>
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Adding…' : 'Add admin'}
                        </Button>
                    </DialogPanelFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
