import { useState, useEffect } from 'react';
import { authedFetch } from '../../services/apiClient';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Badge } from '../ui/badge';
import { Skeleton } from '../ui/skeleton';
import { Plus, MoreHorizontal, Copy, Play, Pause, Archive, Users, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { CreateCompanyDialog } from './CreateCompanyDialog';
import { BootstrapAdminDialog } from './BootstrapAdminDialog';

interface Company {
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'archived' | 'onboarding';
    timezone: string;
    contact_email?: string;
    created_at: string;
    active_users: number;
}

export function CompaniesManager() {
    const [companies, setCompanies] = useState<Company[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    
    // Dialog states
    const [createOpen, setCreateOpen] = useState(false);
    const [bootstrapData, setBootstrapData] = useState<{ id: string, name: string } | null>(null);

    const fetchCompanies = async () => {
        setLoading(true);
        try {
            const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : '';
            const res = await authedFetch(`/api/admin/companies${qs}`);
            if (res.ok) {
                const data = await res.json();
                setCompanies(data.companies || []);
            } else {
                toast.error('Failed to load companies');
            }
        } catch (err: any) {
            toast.error('Connection error', { description: err.message });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const timer = setTimeout(fetchCompanies, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleStatusChange = async (id: string, newStatus: string) => {
        try {
            const res = await authedFetch(`/api/admin/companies/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus, status_reason: `Changed by SuperAdmin to ${newStatus}` })
            });
            if (res.ok) {
                toast.success(`Company marked as ${newStatus}`);
                fetchCompanies();
            } else {
                toast.error('Failed to update status');
            }
        } catch {
            toast.error('Connection error');
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="w-1/3">
                    <Input 
                        placeholder="Search companies..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New Company
                </Button>
            </div>

            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Company</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Users</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading && companies.length === 0 ? (
                            [...Array(3)].map((_, i) => (
                                <TableRow key={i}>
                                    <TableCell><Skeleton className="h-10 w-full" /></TableCell>
                                    <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                                    <TableCell><Skeleton className="h-6 w-12" /></TableCell>
                                    <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                                    <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                                </TableRow>
                            ))
                        ) : companies.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center">
                                    No companies found.
                                </TableCell>
                            </TableRow>
                        ) : (
                            companies.map((c) => (
                                <TableRow key={c.id}>
                                    <TableCell>
                                        <div className="font-medium">{c.name}</div>
                                        <div className="text-sm text-muted-foreground flex items-center gap-2">
                                            {c.slug}
                                            <Button variant="ghost" size="icon" className="h-4 w-4" onClick={() => {
                                                navigator.clipboard.writeText(c.id);
                                                toast.success('Copied ID');
                                            }} title="Copy ID">
                                                <Copy className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={c.status === 'active' ? 'default' : c.status === 'suspended' ? 'destructive' : 'secondary'}>
                                            {c.status}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center text-sm text-muted-foreground">
                                            <Users className="mr-1 h-3 w-3" />
                                            {c.active_users}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-sm">
                                        {new Date(c.created_at).toLocaleDateString()}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="ghost" className="h-8 w-8 p-0">
                                                    <span className="sr-only">Open menu</span>
                                                    <MoreHorizontal className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                                <DropdownMenuItem onClick={() => setBootstrapData({ id: c.id, name: c.name })}>
                                                    <ShieldAlert className="mr-2 h-4 w-4" />
                                                    Bootstrap Admin
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                {c.status === 'active' ? (
                                                    <DropdownMenuItem onClick={() => handleStatusChange(c.id, 'suspended')} className="text-orange-600">
                                                        <Pause className="mr-2 h-4 w-4" /> Suspend
                                                    </DropdownMenuItem>
                                                ) : (
                                                    <DropdownMenuItem onClick={() => handleStatusChange(c.id, 'active')} className="text-green-600">
                                                        <Play className="mr-2 h-4 w-4" /> Activate
                                                    </DropdownMenuItem>
                                                )}
                                                {c.status !== 'archived' && (
                                                    <DropdownMenuItem onClick={() => handleStatusChange(c.id, 'archived')} className="text-red-600">
                                                        <Archive className="mr-2 h-4 w-4" /> Archive
                                                    </DropdownMenuItem>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            <CreateCompanyDialog 
                open={createOpen} 
                onOpenChange={setCreateOpen} 
                onSuccess={fetchCompanies} 
            />
            
            <BootstrapAdminDialog 
                companyId={bootstrapData?.id || null}
                companyName={bootstrapData?.name || ''}
                open={!!bootstrapData} 
                onOpenChange={(o) => !o && setBootstrapData(null)} 
                onSuccess={fetchCompanies} 
            />
        </div>
    );
}
