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
import JobsPage from './pages/JobsPage';
import RouteManagerOverviewPage from './pages/telephony/RouteManagerOverviewPage';
import PhoneNumberGroupsPage from './pages/telephony/PhoneNumberGroupsPage';
import PhoneNumberGroupDetailPage from './pages/telephony/PhoneNumberGroupDetailPage';
import SchedulesPage from './pages/telephony/SchedulesPage';
import ScheduleDetailPage from './pages/telephony/ScheduleDetailPage';
import UserGroupsPage from './pages/telephony/UserGroupsPage';
import UserGroupDetailPage from './pages/telephony/UserGroupDetailPage';
import CallFlowsPage from './pages/telephony/CallFlowsPage';
import CallFlowDetailPage from './pages/telephony/CallFlowDetailPage';
import CallFlowBuilderPage from './pages/telephony/CallFlowBuilderPage';
import PhoneNumbersPage from './pages/telephony/PhoneNumbersPage';
import AudioLibraryPage from './pages/telephony/AudioLibraryPage';
import ProviderSettingsPage from './pages/telephony/ProviderSettingsPage';
import RoutingLogsPage from './pages/telephony/RoutingLogsPage';
import OperationsDashboardPage from './pages/telephony/OperationsDashboardPage';
import QueueOperationsPage from './pages/telephony/QueueOperationsPage';
import ActiveCallWorkspacePage from './pages/telephony/ActiveCallWorkspacePage';
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
              {/* Telephony Admin */}
              <Route path="/settings/telephony" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><RouteManagerOverviewPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/groups" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><PhoneNumberGroupsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/groups/:groupId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><PhoneNumberGroupDetailPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/schedules" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><SchedulesPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/schedules/:scheduleId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><ScheduleDetailPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/user-groups" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><UserGroupsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/user-groups/:groupId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><UserGroupDetailPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              {/* Call Flows */}
              <Route path="/settings/telephony/call-flows" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><CallFlowsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/call-flows/:flowId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><CallFlowDetailPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/call-flows/:flowId/builder/:versionId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <CallFlowBuilderPage />
                </ProtectedRoute>
              } />

              {/* Admin — Phone Numbers, Audio, Provider, Logs */}
              <Route path="/settings/telephony/phone-numbers" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><PhoneNumbersPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/audio-library" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><AudioLibraryPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/provider-settings" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><ProviderSettingsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/settings/telephony/routing-logs" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><RoutingLogsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />

              {/* Operations — Dashboard, Queue, Active Call */}
              <Route path="/calls/dashboard" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><OperationsDashboardPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/calls/queue" element={
                <ProtectedRoute roles={['company_admin']}>
                  <TelephonyLayout><QueueOperationsPage /></TelephonyLayout>
                </ProtectedRoute>
              } />
              <Route path="/calls/live/:callId" element={
                <ProtectedRoute roles={['company_admin']}>
                  <ActiveCallWorkspacePage />
                </ProtectedRoute>
              } />

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

