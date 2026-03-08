import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { Phone, MessageSquare, Users, Settings, Key, BookOpen, FileText, LogOut, Shield, Activity, MessageSquareText, DollarSign, Contact2, Wrench, Briefcase } from 'lucide-react';

interface AppNavProps { activeTab: string; pulseUnreadCount: number; hasRole: (r: string) => boolean; logout: () => void; }

export const AppNavTabs: React.FC<AppNavProps> = ({ activeTab, pulseUnreadCount, hasRole, logout }) => {
    const navigate = useNavigate();
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <h1 className="text-2xl font-semibold" style={{ margin: 0, color: '#202223' }}>Blanc</h1>
            <Tabs value={activeTab} className="w-auto">
                <TabsList>
                    <TabsTrigger value="pulse" className="flex items-center gap-2" onClick={() => navigate('/pulse')} style={{ position: 'relative' }}><Activity className="size-4" />Pulse{pulseUnreadCount > 0 && <span className="pulse-unread-badge" title={`${pulseUnreadCount} unread`}>{pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}</span>}</TabsTrigger>
                    <TabsTrigger value="calls" className="flex items-center gap-2" onClick={() => navigate('/calls')}><Phone className="size-4" />Calls</TabsTrigger>
                    <TabsTrigger value="messages" className="flex items-center gap-2" onClick={() => navigate('/messages')}><MessageSquare className="size-4" />Messages</TabsTrigger>
                    <TabsTrigger value="leads" className="flex items-center gap-2" onClick={() => navigate('/leads')}><Users className="size-4" />Leads</TabsTrigger>
                    <TabsTrigger value="jobs" className="flex items-center gap-2" onClick={() => navigate('/jobs')}><Briefcase className="size-4" />Jobs</TabsTrigger>
                    <TabsTrigger value="contacts" className="flex items-center gap-2" onClick={() => navigate('/contacts')}><Contact2 className="size-4" />Contacts</TabsTrigger>
                    <TabsTrigger value="payments" className="flex items-center gap-2" onClick={() => navigate('/payments')}><DollarSign className="size-4" />Payments</TabsTrigger>
                </TabsList>
            </Tabs>
        </div>
    );
};

export const SettingsMenu: React.FC<{ activeTab: string; hasRole: (r: string) => boolean; logout: () => void }> = ({ activeTab, hasRole, logout }) => {
    const navigate = useNavigate();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="user-menu" style={{ cursor: 'pointer', fontWeight: activeTab === 'settings' ? 600 : 400 }}><Settings className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />Settings</button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/integrations')}><Key className="size-4" />Integrations</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/lead-form')}><FileText className="size-4" />Lead & Job</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/quick-messages')}><MessageSquareText className="size-4" />Quick Messages</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/api-docs')}><BookOpen className="size-4" />API Docs</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/users')}><Users className="size-4" />Users</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/providers')}><Wrench className="size-4" />Providers</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/phone-calls')}><Phone className="size-4" />Phone Calls</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/action-required')}><Activity className="size-4" />Action Required</DropdownMenuItem>
                {hasRole('super_admin') && <><DropdownMenuSeparator /><DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/admin')}><Shield className="size-4" />Super Admin</DropdownMenuItem></>}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer text-red-600" onClick={logout}><LogOut className="size-4" />Log Out</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export function getActiveTab(pathname: string): string {
    if (pathname.startsWith('/pulse')) return 'pulse';
    if (pathname.startsWith('/messages')) return 'messages';
    if (pathname.startsWith('/leads')) return 'leads';
    if (pathname.startsWith('/jobs')) return 'jobs';
    if (pathname.startsWith('/contacts')) return 'contacts';
    if (pathname.startsWith('/payments')) return 'payments';
    if (pathname.startsWith('/settings')) return 'settings';
    if (pathname.startsWith('/calls') || pathname.startsWith('/contact/')) return 'calls';
    return 'pulse';
}
