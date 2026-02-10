import {
    X,
    Phone,
    Mail,
    MapPin,
    Calendar,
    Edit,
    PhoneOff,
    CheckCircle2,
    Briefcase,
    ChevronDown,
    Trash2,
    MoreVertical,
    CornerDownLeft,
    Tag,
    Users,
    FileText,
} from 'lucide-react';
import { format } from 'date-fns';
import { useState, useEffect } from 'react';
import type { Lead } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { Label } from '../ui/label';
import { formatPhone } from '../../lib/formatPhone';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface CustomFieldDef {
    id: string;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    sort_order: number;
}

function MetadataSection({ lead }: { lead: Lead }) {
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);

    useEffect(() => {
        fetch('/api/settings/lead-form')
            .then((r) => r.json())
            .then((data) => {
                if (data.success) {
                    const userFields = data.customFields.filter(
                        (f: CustomFieldDef) => !f.is_system
                    );
                    setCustomFields(userFields);
                }
            })
            .catch(() => { });
    }, []);

    return (
        <div>
            <h4 className="font-medium mb-3">Metadata</h4>
            <div className="space-y-3">
                {/* Job Source */}
                <div className="flex items-start gap-3">
                    <Tag className="size-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1">
                        <Label className="text-xs text-muted-foreground">Job Source</Label>
                        <div className="text-sm font-medium mt-1">
                            {lead.JobSource || <span className="text-muted-foreground">N/A</span>}
                        </div>
                    </div>
                </div>

                {/* Created Date */}
                <div className="flex items-start gap-3">
                    <Calendar className="size-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1">
                        <Label className="text-xs text-muted-foreground">Created Date</Label>
                        <div className="text-sm font-medium mt-1">
                            {lead.CreatedDate
                                ? format(new Date(lead.CreatedDate), 'MMM dd, yyyy HH:mm')
                                : 'N/A'}
                        </div>
                    </div>
                </div>

                {/* Custom user-defined fields */}
                {customFields.map((field) => (
                    <div key={field.id} className="flex items-start gap-3">
                        <FileText className="size-4 mt-0.5 text-muted-foreground" />
                        <div className="flex-1">
                            <Label className="text-xs text-muted-foreground">{field.display_name}</Label>
                            <div className="text-sm font-medium mt-1 whitespace-pre-wrap">
                                {lead.Metadata?.[field.api_name] || <span className="text-muted-foreground">N/A</span>}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

interface LeadDetailPanelProps {
    lead: Lead | null;
    onClose: () => void;
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onUpdateComments: (uuid: string, comments: string) => void;
    onUpdateStatus: (uuid: string, status: string) => void;
    onUpdateSource: (uuid: string, source: string) => void;
    onDelete: (uuid: string) => void;
}

const JOB_TYPES = [
    { value: 'COD', label: 'COD Call of Demand' },
    { value: 'INS', label: 'INS Insurance' },
    { value: 'RUW', label: 'Recall under Warranty' },
];

const JOB_SOURCES = [
    'Website',
    'Referral',
    'Google Ads',
    'Facebook',
    'Yelp',
    'Direct Call',
    'Email',
    'Instagram',
    'LinkedIn',
    'Twitter',
    'Other',
];

export function LeadDetailPanel({
    lead,
    onClose,
    onEdit,
    onMarkLost,
    onActivate,
    onConvert,
    onUpdateComments,
    onUpdateStatus,
    onUpdateSource,
    onDelete,
}: LeadDetailPanelProps) {
    const [comments, setComments] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [isEditingComments, setIsEditingComments] = useState(false);

    useEffect(() => {
        if (lead) {
            setComments(lead.Comments || '');
            setIsEditingComments(false);
        }
    }, [lead]);

    const handleSaveComments = () => {
        if (lead && comments !== lead.Comments) {
            onUpdateComments(lead.UUID, comments);
        }
        setIsFocused(false);
        if (!comments.trim()) {
            setIsEditingComments(false);
        }
    };

    const handleBlur = () => {
        handleSaveComments();
    };

    const handleAddComment = () => {
        setIsEditingComments(true);
        setIsFocused(true);
    };

    if (!lead) {
        return (
            <div className="w-[400px] min-w-[240px] border-l bg-muted/20 hidden md:flex items-center justify-center shrink-0">
                <div className="text-center text-muted-foreground">
                    <Users className="size-12 mx-auto mb-3 opacity-20" />
                    <p>Select a lead to view details</p>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-background md:relative md:inset-auto md:z-auto md:w-[400px] md:min-w-[240px] md:border-l flex flex-col md:bg-background shrink-0">
            {/* Header */}
            <div className="p-4 border-b">
                <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                        <h3 className="font-semibold text-lg">
                            {lead.FirstName} {lead.LastName}
                        </h3>
                        {lead.Company && (
                            <p className="text-sm text-muted-foreground">{lead.Company}</p>
                        )}
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X className="size-4" />
                    </Button>
                </div>

                <div className="flex items-center gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm">
                                <Badge
                                    variant={lead.LeadLost ? 'destructive' : 'default'}
                                    className="cursor-pointer hover:opacity-80 transition-opacity"
                                >
                                    {lead.Status}
                                </Badge>
                                <ChevronDown className="size-3 text-muted-foreground" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {LEAD_STATUSES.map((status) => (
                                <DropdownMenuItem
                                    key={status}
                                    onClick={() => onUpdateStatus(lead.UUID, status)}
                                    className={status === lead.Status ? 'bg-accent' : ''}
                                >
                                    {status}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm">
                                <Badge
                                    variant="outline"
                                    className="cursor-pointer hover:opacity-80 transition-opacity"
                                >
                                    {lead.JobSource || 'No Source'}
                                </Badge>
                                <ChevronDown className="size-3 text-muted-foreground" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {JOB_SOURCES.map((source) => (
                                <DropdownMenuItem
                                    key={source}
                                    onClick={() => onUpdateSource(lead.UUID, source)}
                                    className={source === lead.JobSource ? 'bg-accent' : ''}
                                >
                                    {source}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {lead.SubStatus && (
                        <Badge variant="outline">{lead.SubStatus}</Badge>
                    )}
                    <span className="text-xs text-muted-foreground font-mono ml-auto">
                        {lead.SerialId}
                    </span>
                </div>
            </div>

            {/* Details */}
            <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                    {/* Contact Information */}
                    <div>
                        <h4 className="font-medium mb-3">Contact Information</h4>
                        <div className="space-y-3">
                            {/* Comments */}
                            {(comments.trim() || isEditingComments) ? (
                                <div className="relative bg-rose-50 rounded-lg border border-rose-100 py-1 px-2">
                                    <textarea
                                        className="w-full text-sm resize-none bg-transparent border-none outline-none min-h-[24px] pr-16 leading-6"
                                        value={comments}
                                        onChange={(e) => setComments(e.target.value)}
                                        onFocus={() => setIsFocused(true)}
                                        onBlur={handleBlur}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSaveComments();
                                            }
                                        }}
                                        placeholder="Add comments..."
                                        rows={1}
                                        autoFocus={isEditingComments}
                                        style={{
                                            height: 'auto',
                                            minHeight: '24px',
                                        }}
                                        onInput={(e) => {
                                            const target = e.target as HTMLTextAreaElement;
                                            target.style.height = 'auto';
                                            target.style.height = `${target.scrollHeight}px`;
                                        }}
                                    />
                                    {isFocused && (
                                        <Button
                                            size="sm"
                                            className="absolute top-1 right-1.5 h-6 px-2 text-xs"
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={handleSaveComments}
                                        >
                                            <CornerDownLeft className="size-3 mr-1" />
                                            Enter
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <button
                                    onClick={handleAddComment}
                                    className="text-sm text-muted-foreground hover:text-foreground transition-colors underline decoration-dashed decoration-1 underline-offset-4"
                                >
                                    + Add comment
                                </button>
                            )}

                            <div className="flex items-start gap-3">
                                <Phone className="size-4 mt-0.5 text-muted-foreground" />
                                <div className="flex-1">
                                    <Label className="text-xs text-muted-foreground">Phone</Label>
                                    <div className="flex items-center gap-2">
                                        <a
                                            href={`tel:${lead.Phone}`}
                                            className="text-sm font-medium text-foreground no-underline hover:underline"
                                        >
                                            {formatPhone(lead.Phone)}
                                        </a>
                                        {lead.PhoneExt && (
                                            <span className="text-xs text-muted-foreground">
                                                ext. {lead.PhoneExt}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {lead.SecondPhone && (
                                <div className="flex items-start gap-3">
                                    <Phone className="size-4 mt-0.5 text-muted-foreground" />
                                    <div className="flex-1">
                                        <Label className="text-xs text-muted-foreground">
                                            Secondary Phone
                                        </Label>
                                        <div className="flex items-center gap-2">
                                            <a
                                                href={`tel:${lead.SecondPhone}`}
                                                className="text-sm font-medium text-foreground no-underline hover:underline"
                                            >
                                                {formatPhone(lead.SecondPhone)}
                                            </a>
                                            {lead.SecondPhoneExt && (
                                                <span className="text-xs text-muted-foreground">
                                                    ext. {lead.SecondPhoneExt}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {lead.Email && (
                                <div className="flex items-start gap-3">
                                    <Mail className="size-4 mt-0.5 text-muted-foreground" />
                                    <div className="flex-1">
                                        <Label className="text-xs text-muted-foreground">Email</Label>
                                        <a
                                            href={`mailto:${lead.Email}`}
                                            className="text-sm font-medium text-foreground no-underline hover:underline block"
                                        >
                                            {lead.Email}
                                        </a>
                                    </div>
                                </div>
                            )}

                            {/* Address */}
                            {(lead.Address || lead.City) && (
                                <div className="flex items-start gap-3">
                                    <MapPin className="size-4 mt-0.5 text-muted-foreground" />
                                    <div className="flex-1">
                                        <Label className="text-xs text-muted-foreground">Address</Label>
                                        <div className="text-sm font-medium mt-1">
                                            {lead.Address && (
                                                <div>
                                                    {lead.Address}
                                                    {lead.Unit && `, Unit ${lead.Unit}`}
                                                </div>
                                            )}
                                            {lead.City && (
                                                <div>
                                                    {lead.City}, {lead.State} {lead.PostalCode}
                                                </div>
                                            )}
                                            {lead.Country && <div>{lead.Country}</div>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <Separator />

                    {/* Job Details */}
                    <div>
                        <h4 className="font-medium mb-3">Job Details</h4>

                        <div className="space-y-3">
                            {/* Job Type */}
                            <div>
                                <Label className="text-xs text-muted-foreground">Job Type</Label>
                                <div className="text-sm font-medium mt-1">
                                    {lead.JobType
                                        ? JOB_TYPES.find((t) => t.value === lead.JobType)?.label ||
                                        lead.JobType
                                        : <span className="text-muted-foreground">N/A</span>}
                                </div>
                            </div>

                            {/* Description */}
                            <div>
                                <Label className="text-xs text-muted-foreground">Description</Label>
                                <div className="text-sm mt-1 whitespace-pre-wrap">
                                    {lead.LeadNotes || <span className="text-muted-foreground">N/A</span>}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Metadata */}
                    <Separator />
                    <MetadataSection lead={lead} />
                </div>
            </div>

            {/* Footer Actions */}
            <div className="p-4 border-t space-y-2">
                {lead.Status !== 'Converted' && !lead.LeadLost && (
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onEdit(lead)}
                            className="h-12"
                        >
                            <Edit className="size-4 mr-2" />
                            Edit
                        </Button>

                        <Button
                            size="sm"
                            onClick={() => onConvert(lead.UUID)}
                            className="flex-1 h-12"
                        >
                            <Briefcase className="size-4 mr-2" />
                            Convert to Job
                        </Button>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" className="h-12">
                                    <MoreVertical className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    onClick={() => onMarkLost(lead.UUID)}
                                    className="text-orange-600"
                                >
                                    <PhoneOff className="size-4 mr-2" />
                                    Mark Lost
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => onDelete(lead.UUID)}
                                    className="text-destructive"
                                >
                                    <Trash2 className="size-4 mr-2" />
                                    Delete Lead
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                )}

                {(lead.Status === 'Converted' || lead.LeadLost) && (
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onEdit(lead)}
                            className="h-12"
                        >
                            <Edit className="size-4 mr-2" />
                            Edit
                        </Button>

                        {lead.LeadLost && (
                            <Button
                                size="sm"
                                onClick={() => onActivate(lead.UUID)}
                                className="flex-1 h-12"
                            >
                                <CheckCircle2 className="size-4 mr-2" />
                                Activate
                            </Button>
                        )}

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" className="h-12">
                                    <MoreVertical className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                {!lead.LeadLost && (
                                    <DropdownMenuItem
                                        onClick={() => onMarkLost(lead.UUID)}
                                        className="text-orange-600"
                                    >
                                        <PhoneOff className="size-4 mr-2" />
                                        Mark Lost
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                    onClick={() => onDelete(lead.UUID)}
                                    className="text-destructive"
                                >
                                    <Trash2 className="size-4 mr-2" />
                                    Delete Lead
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                )}
            </div>
        </div>
    );
}
