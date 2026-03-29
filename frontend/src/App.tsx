import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppLayout } from './components/layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { ConversationPage } from './pages/ConversationPage';
import { LeadsPage } from './pages/LeadsPage';
import { ContactsPage } from './pages/ContactsPage';
import { PulsePage } from './pages/PulsePage';
import { MessagesPage } from './pages/MessagesPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import ApiDocsPage from './pages/ApiDocsPage';
import LeadFormSettingsPage from './pages/LeadFormSettingsPage';
import SuperAdminPage from './pages/SuperAdminPage';
import AdminCompanyDetailPage from './pages/AdminCompanyDetailPage';
import CompanyUsersPage from './pages/CompanyUsersPage';
import QuickMessagesPage from './pages/QuickMessagesPage';
import PaymentsPage from './pages/PaymentsPage';
import ProvidersPage from './pages/ProvidersPage';
import PhoneCallsSettingsPage from './pages/PhoneCallsSettingsPage';
import ActionRequiredSettingsPage from './pages/ActionRequiredSettingsPage';
import JobsPage from './pages/JobsPage';
import { SchedulePage } from './pages/SchedulePage';
import EstimatesPage from './pages/EstimatesPage';
import InvoicesPage from './pages/InvoicesPage';
import TransactionsPage from './pages/TransactionsPage';
import RouteManagerOverviewPage from './pages/telephony/RouteManagerOverviewPage';
import CallFlowBuilderPage from './pages/telephony/CallFlowBuilderPage';
import PhoneNumbersPage from './pages/telephony/PhoneNumbersPage';
import AudioLibraryPage from './pages/telephony/AudioLibraryPage';
import ProviderSettingsPage from './pages/telephony/ProviderSettingsPage';
import RoutingLogsPage from './pages/telephony/RoutingLogsPage';
import OperationsDashboardPage from './pages/telephony/OperationsDashboardPage';

import ActiveCallWorkspacePage from './pages/telephony/ActiveCallWorkspacePage';
import UserGroupsPage from './pages/telephony/UserGroupsPage';

import TelephonyLayout from './components/telephony/TelephonyLayout';
import { EventNotification } from './components/EventNotification';
import NotificationReminderBanner from './components/NotificationReminderBanner';
import SSEPushBridge from './components/SSEPushBridge';
import { Toaster } from './components/ui/sonner';
import './App.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false
    }
  }
});

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/pulse" replace />} />
              <Route path="/pulse" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/pulse/contact/:id" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/pulse/timeline/:id" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/calls" element={<HomePage />} />
              <Route path="/contact/:id" element={<ProtectedRoute permissions={['messages.view_internal']}><ConversationPage /></ProtectedRoute>} />
              <Route path="/calls/:callSid" element={<ProtectedRoute permissions={['messages.view_internal']}><ConversationPage /></ProtectedRoute>} />
              <Route path="/messages" element={<ProtectedRoute permissions={['messages.view_internal']}><MessagesPage /></ProtectedRoute>} />
              <Route path="/leads" element={<ProtectedRoute permissions={['leads.view']}><LeadsPage /></ProtectedRoute>} />
              <Route path="/leads/:leadId" element={<ProtectedRoute permissions={['leads.view']}><LeadsPage /></ProtectedRoute>} />
              <Route path="/jobs" element={<ProtectedRoute permissions={['jobs.view']}><JobsPage /></ProtectedRoute>} />
              <Route path="/jobs/:jobId" element={<ProtectedRoute permissions={['jobs.view']}><JobsPage /></ProtectedRoute>} />
              <Route path="/schedule" element={<ProtectedRoute permissions={['jobs.view']}><SchedulePage /></ProtectedRoute>} />
              <Route path="/estimates" element={<ProtectedRoute permissions={['estimates.view']}><EstimatesPage /></ProtectedRoute>} />
              <Route path="/invoices" element={<ProtectedRoute permissions={['invoices.view']}><InvoicesPage /></ProtectedRoute>} />
              <Route path="/contacts" element={<ProtectedRoute permissions={['contacts.view']}><ContactsPage /></ProtectedRoute>} />
              <Route path="/contacts/:contactId" element={<ProtectedRoute permissions={['contacts.view']}><ContactsPage /></ProtectedRoute>} />
              
              <Route path="/settings" element={<Navigate to="/settings/integrations" replace />} />
              <Route path="/settings/integrations" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><IntegrationsPage /></ProtectedRoute>} />
              <Route path="/settings/api-docs" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><ApiDocsPage /></ProtectedRoute>} />
              
              <Route path="/settings/lead-form" element={<ProtectedRoute permissions={['tenant.company.manage']}><LeadFormSettingsPage /></ProtectedRoute>} />
              <Route path="/settings/quick-messages" element={<ProtectedRoute permissions={['tenant.company.manage']}><QuickMessagesPage /></ProtectedRoute>} />
              
              <Route path="/payments" element={<ProtectedRoute permissions={['payments.view']}><PaymentsPage /></ProtectedRoute>} />
              <Route path="/payments/:paymentId" element={<ProtectedRoute permissions={['payments.view']}><PaymentsPage /></ProtectedRoute>} />
              <Route path="/transactions" element={<ProtectedRoute permissions={['payments.view']}><TransactionsPage /></ProtectedRoute>} />
              
              <Route path="/settings/providers" element={<ProtectedRoute permissions={['tenant.company.manage']}><ProvidersPage /></ProtectedRoute>} />
              <Route path="/settings/phone-calls" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><PhoneCallsSettingsPage /></ProtectedRoute>} />
              
              <Route path="/settings/action-required" element={<Navigate to="/settings/actions-notifications" replace />} />
              <Route path="/settings/actions-notifications" element={<ProtectedRoute permissions={['tenant.company.manage']}><ActionRequiredSettingsPage /></ProtectedRoute>} />
              
              <Route path="/settings/users" element={<ProtectedRoute permissions={['tenant.users.manage']}><CompanyUsersPage /></ProtectedRoute>} />
              <Route path="/settings/admin" element={<ProtectedRoute roles={['super_admin']}><SuperAdminPage /></ProtectedRoute>} />
              <Route path="/settings/admin/companies/:companyId" element={<ProtectedRoute roles={['super_admin']}><AdminCompanyDetailPage /></ProtectedRoute>} />

              {/* Telephony — Configuration (with sidebar) */}
              <Route path="/settings/telephony" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><RouteManagerOverviewPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/user-groups" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><UserGroupsPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/phone-numbers" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><PhoneNumbersPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/audio-library" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><AudioLibraryPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/provider-settings" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><ProviderSettingsPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/routing-logs" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><RoutingLogsPage /></TelephonyLayout></ProtectedRoute>} />

              {/* Call Flow Builder — full-screen, accessed from User Group detail */}
              <Route path="/settings/telephony/user-groups/:groupId/flow" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><CallFlowBuilderPage /></ProtectedRoute>} />

              {/* Operations — Dashboard & Queue (with sidebar) */}
              <Route path="/calls/dashboard" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><OperationsDashboardPage /></TelephonyLayout></ProtectedRoute>} />

              {/* Active Call Workspace — full-screen */}
              <Route path="/calls/live/:callId" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><ActiveCallWorkspacePage /></ProtectedRoute>} />

            </Routes>
          </AppLayout>
          <EventNotification />
          <NotificationReminderBanner />
          <SSEPushBridge />
          <Toaster />
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;

