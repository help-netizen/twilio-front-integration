import { Calendar, MapPin, User2, Mail, Phone } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import { formatPhone } from '../../lib/formatPhone';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobInfoSectionsProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string } | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobInfoSections({ job, contactInfo }: JobInfoSectionsProps) {
    return (
        <>
            {/* ── Schedule ── */}
            <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">Schedule</h3>
                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                            <Calendar className="size-5 text-muted-foreground" />
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground">Date & Time</p>
                            {job.start_date ? (
                                <>
                                    <p className="font-medium">
                                        {new Date(job.start_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        {new Date(job.start_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                        {job.end_date && ` - ${new Date(job.end_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                                    </p>
                                </>
                            ) : (
                                <p className="font-medium text-muted-foreground">Not scheduled</p>
                            )}
                        </div>
                    </div>

                    {(job.address || job.territory) && (
                        <div className="flex items-start gap-3">
                            <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                <MapPin className="size-5 text-muted-foreground" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">
                                    Service Area{job.territory ? `: ${job.territory}` : ''}
                                </p>
                                {job.address && <p className="font-medium">{job.address}</p>}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Assigned Providers ── */}
            <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">Assigned Providers</h3>
                {job.assigned_techs && job.assigned_techs.length > 0 ? (
                    <div className="space-y-2">
                        {job.assigned_techs.map((p: any) => (
                            <div key={p.id} className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                                <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center">
                                    <User2 className="size-5 text-primary" />
                                </div>
                                <div className="flex-1">
                                    <p className="font-medium">{p.name}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-sm text-muted-foreground">No providers assigned</div>
                )}
            </div>

            {/* ── Customer ── */}
            <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">Customer</h3>
                <div className="space-y-3">
                    {(contactInfo?.email || job.customer_email) && (
                        <div className="flex items-center gap-3">
                            <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                <Mail className="size-5 text-muted-foreground" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Email</p>
                                <p className="font-medium">
                                    <a href={`mailto:${contactInfo?.email || job.customer_email}`}
                                        className="text-foreground no-underline hover:underline">
                                        {contactInfo?.email || job.customer_email}
                                    </a>
                                </p>
                            </div>
                        </div>
                    )}
                    {(contactInfo?.phone || job.customer_phone) && (
                        <div className="flex items-center gap-3">
                            <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                <Phone className="size-5 text-muted-foreground" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Phone</p>
                                <div className="flex items-center gap-1">
                                    <a href={`tel:${contactInfo?.phone || job.customer_phone}`}
                                        className="font-medium text-foreground no-underline hover:underline">
                                        {formatPhone(contactInfo?.phone || job.customer_phone)}
                                    </a>
                                    <ClickToCallButton
                                        phone={contactInfo?.phone || job.customer_phone || ''}
                                        contactName={contactInfo?.name || job.customer_name || undefined}
                                    />
                                    <OpenTimelineButton
                                        phone={contactInfo?.phone || job.customer_phone || ''}
                                        contactId={contactInfo?.id}
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Invoice ── */}
            {job.invoice_total && (
                <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">Invoice</h3>
                    <div className="border rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="font-semibold">Total</span>
                            <span className="text-xl font-bold">${job.invoice_total}</span>
                        </div>
                        {job.invoice_status && (
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">Status</span>
                                <span className="text-xs px-2 py-0.5 rounded-md bg-secondary">{job.invoice_status}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
