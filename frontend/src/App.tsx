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
import CompanyUsersPage from './pages/CompanyUsersPage';
import QuickMessagesPage from './pages/QuickMessagesPage';
import PaymentsPage from './pages/PaymentsPage';
import ProvidersPage from './pages/ProvidersPage';
import PhoneCallsSettingsPage from './pages/PhoneCallsSettingsPage';
import ActionRequiredSettingsPage from './pages/ActionRequiredSettingsPage';
import JobsPage from './pages/JobsPage';
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
              <Route path="/pulse" element={<PulsePage />} />
              <Route path="/pulse/contact/:id" element={<PulsePage />} />
              <Route path="/pulse/timeline/:id" element={<PulsePage />} />
              <Route path="/calls" element={<HomePage />} />
              <Route path="/contact/:id" element={<ConversationPage />} />
              <Route path="/calls/:callSid" element={<ConversationPage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/leads" element={<LeadsPage />} />
              <Route path="/leads/:leadId" element={<LeadsPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:jobId" element={<JobsPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/contacts/:contactId" element={<ContactsPage />} />
              <Route path="/settings" element={<Navigate to="/settings/integrations" replace />} />
              <Route path="/settings/integrations" element={
                <ProtectedRoute roles={['company_admin']}>
                  <IntegrationsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/api-docs" element={
                <ProtectedRoute roles={['company_admin']}>
                  <ApiDocsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/lead-form" element={
                <ProtectedRoute roles={['company_admin', 'company_member']}>
                  <LeadFormSettingsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/quick-messages" element={
                <ProtectedRoute roles={['company_admin', 'company_member']}>
                  <QuickMessagesPage />
                </ProtectedRoute>
              } />
              <Route path="/payments" element={
                <ProtectedRoute roles={['company_admin']}>
                  <PaymentsPage />
                </ProtectedRoute>
              } />
              <Route path="/payments/:paymentId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <PaymentsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/providers" element={
                <ProtectedRoute roles={['company_admin', 'company_member']}>
                  <ProvidersPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/phone-calls" element={
                <ProtectedRoute roles={['company_admin']}>
                  <PhoneCallsSettingsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/action-required" element={
                <ProtectedRoute roles={['company_admin']}>
                  <ActionRequiredSettingsPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/users" element={
                <ProtectedRoute roles={['company_admin']}>
                  <CompanyUsersPage />
                </ProtectedRoute>
              } />
              <Route path="/settings/admin" element={
                <ProtectedRoute roles={['super_admin']}>
                  <SuperAdminPage />
                </ProtectedRoute>
              } />

              {/* Telephony — Configuration (with sidebar) */}
              <Route path="/settings/telephony" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><RouteManagerOverviewPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/user-groups" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><UserGroupsPage /></TelephonyLayout></ProtectedRoute>} />

              <Route path="/settings/telephony/phone-numbers" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><PhoneNumbersPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/audio-library" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><AudioLibraryPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/provider-settings" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><ProviderSettingsPage /></TelephonyLayout></ProtectedRoute>} />
              <Route path="/settings/telephony/routing-logs" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><RoutingLogsPage /></TelephonyLayout></ProtectedRoute>} />

              {/* Call Flow Builder — full-screen, accessed from User Group detail */}
              <Route path="/settings/telephony/user-groups/:groupId/flow" element={<ProtectedRoute roles={['company_admin']}><CallFlowBuilderPage /></ProtectedRoute>} />

              {/* Operations — Dashboard & Queue (with sidebar) */}
              <Route path="/calls/dashboard" element={<ProtectedRoute roles={['company_admin']}><TelephonyLayout><OperationsDashboardPage /></TelephonyLayout></ProtectedRoute>} />


              {/* Active Call Workspace — full-screen */}
              <Route path="/calls/live/:callId" element={<ProtectedRoute roles={['company_admin']}><ActiveCallWorkspacePage /></ProtectedRoute>} />

            </Routes>
          </AppLayout>
          <EventNotification />
          <Toaster />
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;

