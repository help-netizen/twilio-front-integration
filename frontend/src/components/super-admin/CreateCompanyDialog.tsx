import { useState } from 'react';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { Dialog, DialogContent, DialogDescription, DialogPanelFooter, DialogPanelHeader, DialogBody, DialogTitle } from '../ui/dialog';
import { toast } from 'sonner';
import { authedFetch } from '../../services/apiClient';

interface CreateCompanyDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

export function CreateCompanyDialog({ open, onOpenChange, onSuccess }: CreateCompanyDialogProps) {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        name: '',
        slug: '',
        timezone: 'America/New_York',
        locale: 'en-US',
        admin_email: '',
    });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value,
            // Auto-generate slug from name if slug hasn't been manually edited yet
            ...(name === 'name' && !prev.slug ? { slug: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') } : {})
        }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const res = await authedFetch('/api/admin/companies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            if (res.ok) {
                const data = await res.json();
                if (data.admin_bootstrapped === false) {
                    toast.warning('Company created, but admin bootstrap failed', {
                        description: data.bootstrap_error || 'You can retry via company menu.'
                    });
                } else {
                    toast.success('Company created with admin user');
                }
                setFormData({ name: '', slug: '', timezone: 'America/New_York', locale: 'en-US', admin_email: '' });
                onSuccess();
                onOpenChange(false);
            } else {
                const data = await res.json();
                toast.error('Failed to create company', { description: data.error });
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
                            Create Company
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            Create a new tenant company and bootstrap its first administrator.
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="name" name="name" label="Company Name" value={formData.name} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                                <FloatingField id="slug" name="slug" label="URL Slug" value={formData.slug} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="timezone" name="timezone" label="Timezone" value={formData.timezone} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                                <FloatingField id="locale" name="locale" label="Locale" value={formData.locale} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                            </div>
                            <FloatingField id="admin_email" name="admin_email" label="Admin Email" type="email" value={formData.admin_email} onChange={(e) => handleChange(e as React.ChangeEvent<HTMLInputElement>)} />
                            <p className="text-xs text-muted-foreground">First admin user will be created with this email.</p>
                        </div>
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Creating...' : 'Create Company'}
                        </Button>
                    </DialogPanelFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
