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
              <Route path="/settings/payments" element={
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

