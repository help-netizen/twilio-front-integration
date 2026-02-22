import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import {
    Table,
    TableHeader,
    TableRow,
    TableHead,
    TableBody,
    TableCell,
} from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Phone, Headphones, Monitor } from 'lucide-react';

// Types
interface PhoneNumberSetting {
    id: number;
    phone_number: string;
    friendly_name: string | null;
    routing_mode: 'sip' | 'client';
    client_identity: string | null;
    created_at: string;
    updated_at: string;
}

// API functions
async function fetchPhoneSettings(): Promise<PhoneNumberSetting[]> {
    const res = await authedFetch('/api/phone-settings');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data.data;
}

async function updatePhoneRouting(id: number, routing_mode: string, client_identity?: string) {
    const res = await authedFetch(`/api/phone-settings/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routing_mode, client_identity }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data.data;
}

// Format phone for display
function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
}

export default function PhoneCallsSettingsPage() {
    const queryClient = useQueryClient();

    const { data: settings = [], isLoading } = useQuery({
        queryKey: ['phone-settings'],
        queryFn: fetchPhoneSettings,
    });

    const updateMutation = useMutation({
        mutationFn: ({ id, routing_mode, client_identity }: { id: number; routing_mode: string; client_identity?: string }) =>
            updatePhoneRouting(id, routing_mode, client_identity),
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: ['phone-settings'] });
            const label = variables.routing_mode === 'client' ? 'Blanc SoftPhone' : 'Bria (SIP)';
            toast.success(`Routing updated to ${label}`);
        },
        onError: () => toast.error('Failed to update routing'),
    });

    function handleToggle(setting: PhoneNumberSetting) {
        const newMode = setting.routing_mode === 'sip' ? 'client' : 'sip';
        // When switching to client mode, use the default softphone identity
        const clientIdentity = newMode === 'client'
            ? 'user_d8321d18-f20c-4dd9-8dce-353f284bd16c' // Will come from env/server in future
            : undefined;
        updateMutation.mutate({ id: setting.id, routing_mode: newMode, client_identity: clientIdentity });
    }

    return (
        <div className="p-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-semibold">Phone Calls</h1>
                <p className="text-muted-foreground text-sm mt-1">
                    Configure call routing for each registered phone number
                </p>
            </div>

            <Separator className="mb-6" />

            {/* Info box */}
            <div className="border rounded-lg p-4 mb-6 bg-blue-50/50 border-blue-200">
                <p className="text-sm text-blue-800">
                    <strong>Routing modes:</strong>
                </p>
                <div className="flex gap-6 mt-2 text-sm text-blue-700">
                    <span className="flex items-center gap-1.5">
                        <Headphones className="h-4 w-4" />
                        <strong>Bria (SIP)</strong> — calls ring on Bria desktop app
                    </span>
                    <span className="flex items-center gap-1.5">
                        <Monitor className="h-4 w-4" />
                        <strong>Blanc SoftPhone</strong> — calls ring in the browser
                    </span>
                </div>
            </div>

            {/* Table */}
            {isLoading ? (
                <div className="text-center text-muted-foreground py-12">Loading phone numbers…</div>
            ) : settings.length === 0 ? (
                <div className="text-center py-12">
                    <Phone className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">No phone numbers found</p>
                    <p className="text-sm text-muted-foreground mt-1">
                        Phone numbers from your Twilio account will appear here.
                    </p>
                </div>
            ) : (
                <div className="border rounded-lg overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/50">
                                <TableHead className="font-semibold">Phone Number</TableHead>
                                <TableHead className="font-semibold">Friendly Name</TableHead>
                                <TableHead className="font-semibold">Routing</TableHead>
                                <TableHead className="font-semibold text-right">Action</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {settings.map((setting) => (
                                <TableRow key={setting.id}>
                                    <TableCell className="font-mono font-medium">
                                        {formatPhone(setting.phone_number)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {setting.friendly_name || '—'}
                                    </TableCell>
                                    <TableCell>
                                        {setting.routing_mode === 'client' ? (
                                            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 gap-1">
                                                <Monitor className="h-3 w-3" />
                                                Blanc SoftPhone
                                            </Badge>
                                        ) : (
                                            <Badge variant="secondary" className="gap-1">
                                                <Headphones className="h-3 w-3" />
                                                Bria (SIP)
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <button
                                            onClick={() => handleToggle(setting)}
                                            disabled={updateMutation.isPending}
                                            className={`
                                                px-3 py-1.5 rounded text-sm font-medium transition-colors
                                                ${setting.routing_mode === 'sip'
                                                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                                                    : 'bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200'
                                                }
                                                disabled:opacity-50
                                            `}
                                        >
                                            {setting.routing_mode === 'sip'
                                                ? '→ Switch to Blanc'
                                                : '→ Switch to Bria'
                                            }
                                        </button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}
