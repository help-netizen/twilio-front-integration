import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
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
        contact_email: '',
        contact_phone: '',
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
                toast.success('Company created successfully');
                setFormData({ name: '', slug: '', timezone: 'America/New_York', locale: 'en-US', contact_email: '', contact_phone: '' });
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
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Create Company</DialogTitle>
                        <DialogDescription>
                            Create a new tenant company workspace.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="name">Company Name</Label>
                            <Input id="name" name="name" value={formData.name} onChange={handleChange} required placeholder="e.g. Acme Corp" />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="slug">URL Slug</Label>
                            <Input id="slug" name="slug" value={formData.slug} onChange={handleChange} required placeholder="acme-corp" />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="timezone">Timezone</Label>
                                <Input id="timezone" name="timezone" value={formData.timezone} onChange={handleChange} required />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="locale">Locale</Label>
                                <Input id="locale" name="locale" value={formData.locale} onChange={handleChange} required />
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="contact_email">Contact Email (Optional)</Label>
                            <Input id="contact_email" name="contact_email" type="email" value={formData.contact_email} onChange={handleChange} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Creating...' : 'Create Company'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
