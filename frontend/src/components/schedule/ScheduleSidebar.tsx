/**
 * ScheduleSidebar — Detail panel for selected schedule item.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
    X, MapPin, Phone, Mail, User, ExternalLink,
    Briefcase, UserPlus, CheckSquare,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { ScrollArea } from '../ui/scroll-area';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import type { ScheduleItem } from '../../services/scheduleApi';
import { ENTITY_STYLES } from './ScheduleItemCard';
import { formatDateTimeInTZ, formatTimeInTZ } from '../../utils/companyTime';

interface ScheduleSidebarProps {
    item: ScheduleItem;
    onClose: () => void;
    /** Company timezone for time formatting */
    timezone?: string;
}

const ENTITY_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
    job:  { label: 'Job',  icon: Briefcase },
    lead: { label: 'Lead', icon: UserPlus },
    task: { label: 'Task', icon: CheckSquare },
};

function getDetailLink(item: ScheduleItem): string {
    switch (item.entity_type) {
        case 'job':  return `/jobs/${item.entity_id}`;
        case 'lead': return `/leads/${item.entity_id}`;
        default:     return '#';
    }
}

export const ScheduleSidebar: React.FC<ScheduleSidebarProps> = ({ item, onClose, timezone }) => {
    const navigate = useNavigate();
    const entityInfo = ENTITY_LABELS[item.entity_type] ?? ENTITY_LABELS.task;
    const style = ENTITY_STYLES[item.entity_type] ?? ENTITY_STYLES.task;
    const Icon = entityInfo.icon;

    return (
        <div className="w-72 border-l bg-white flex flex-col flex-shrink-0">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b">
                <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className={`${style.bg} ${style.text} border-${style.border.replace('border-', '')} text-xs`}>
                        <Icon className="size-3 mr-1" />
                        {entityInfo.label}
                    </Badge>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                    <X className="size-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1">
                <div className="p-3 space-y-4">
                    {/* Title */}
                    <div>
                        <h3 className="text-sm font-semibold text-gray-900">{item.title}</h3>
                        {item.subtitle && <p className="text-xs text-gray-500 mt-0.5">{item.subtitle}</p>}
                    </div>

                    {/* Status */}
                    <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">Status</div>
                        <Badge variant="secondary" className="text-xs">{item.status}</Badge>
                    </div>

                    {/* Schedule */}
                    {item.start_at && (
                        <div>
                            <div className="text-xs font-medium text-gray-500 mb-1">Scheduled</div>
                            <div className="text-sm text-gray-700">
                                {formatDateTimeInTZ(new Date(item.start_at), timezone)}
                                {item.end_at && (
                                    <span> - {formatTimeInTZ(new Date(item.end_at), timezone)}</span>
                                )}
                            </div>
                        </div>
                    )}

                    <Separator />

                    {/* Contact info */}
                    <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500">Contact</div>
                        {item.customer_name && (
                            <div className="flex items-center gap-2 text-sm text-gray-700">
                                <User className="size-3.5 text-gray-400 flex-shrink-0" />
                                <span>{item.customer_name}</span>
                            </div>
                        )}
                        {item.customer_phone && (
                            <div className="flex items-center gap-2 text-sm text-gray-700">
                                <Phone className="size-3.5 text-gray-400 flex-shrink-0" />
                                <span>{item.customer_phone}</span>
                                <ClickToCallButton phone={item.customer_phone} contactName={item.customer_name} inline />
                            </div>
                        )}
                        {item.customer_email && (
                            <div className="flex items-center gap-2 text-sm text-gray-700">
                                <Mail className="size-3.5 text-gray-400 flex-shrink-0" />
                                <span className="truncate">{item.customer_email}</span>
                            </div>
                        )}
                    </div>

                    {/* Address */}
                    {item.address_summary && (
                        <>
                            <Separator />
                            <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">Address</div>
                                <div className="flex items-start gap-2 text-sm text-gray-700">
                                    <MapPin className="size-3.5 text-gray-400 flex-shrink-0 mt-0.5" />
                                    <span>{item.address_summary}</span>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Assigned techs */}
                    {item.assigned_techs && item.assigned_techs.length > 0 && (
                        <>
                            <Separator />
                            <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">Assigned To</div>
                                <div className="flex flex-wrap gap-1">
                                    {item.assigned_techs.map((tech: any) => (
                                        <Badge key={tech.id || tech.name} variant="outline" className="text-xs">
                                            {tech.name}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Tags */}
                    {item.tags && item.tags.length > 0 && (
                        <>
                            <Separator />
                            <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">Tags</div>
                                <div className="flex flex-wrap gap-1">
                                    {item.tags.map(tag => (
                                        <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    <Separator />

                    {/* Actions */}
                    <div className="space-y-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start text-sm"
                            onClick={() => navigate(getDetailLink(item))}
                        >
                            <ExternalLink className="size-3.5 mr-2" />
                            Open {entityInfo.label} Detail
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start text-sm"
                            onClick={() => navigate(`/pulse?search=${encodeURIComponent(item.customer_phone || item.customer_name || '')}`)}
                        >
                            <ExternalLink className="size-3.5 mr-2" />
                            Open in Pulse
                        </Button>
                    </div>
                </div>
            </ScrollArea>
        </div>
    );
};
