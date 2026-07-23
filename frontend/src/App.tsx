import { syncClock } from './utils/serverClock';
syncClock(); // align client clock with server — fixes timezone DB drift (e.g. Kazakhstan)

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import SignupPage from './pages/auth/SignupPage';
import OnboardingPage from './pages/auth/OnboardingPage';
import TwoFactorGate from './components/auth/TwoFactorGate';
import { useAuth } from './auth/AuthProvider';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** ALB-101: authenticated users without a company go to onboarding. */
function OnboardingGate() {
  const { authenticated, company, loading, platformRole, authzReady } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const publicPath = location.pathname.startsWith('/signup') || location.pathname.startsWith('/onboarding');
    // ONBOARD-LOOP-FIX: only a genuine tenant user with a LOADED, empty context is
    // sent to onboarding. Never loop (a) a platform admin — company is null by
    // design for super_admin — or (b) before authz has actually resolved: a load
    // race would otherwise bounce a fully-onboarded user back to phone verification
    // forever ("You don't have access here" ⇄ SMS prompt flicker).
    if (!loading && authenticated && authzReady && platformRole === 'none' && !company && !publicPath) {
      navigate('/onboarding', { replace: true });
    }
  }, [authenticated, company, loading, authzReady, platformRole, location.pathname, navigate]);
  return null;
}
import { AppLayout } from './components/layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { ConversationPage } from './pages/ConversationPage';
import { LeadsPage } from './pages/LeadsPage';
import { ContactsPage } from './pages/ContactsPage';
import { PulsePage } from './pages/PulsePage';
import WelcomePage from './pages/WelcomePage';
import { MessagesPage } from './pages/MessagesPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import CompanySettingsPage from './pages/CompanySettingsPage';
import VapiSettingsPage from './pages/VapiSettingsPage';
import StripePaymentsSettingsPage from './pages/StripePaymentsSettingsPage';
import MailSecretarySettingsPage from './pages/MailSecretarySettingsPage';
import OutboundLeadCallerSettingsPage from './pages/OutboundLeadCallerSettingsPage';
import OutboundPartsCallerSettingsPage from './pages/OutboundPartsCallerSettingsPage';
import PublicInvoicePayPage from './pages/PublicInvoicePayPage';
import PublicPayThanksPage from './pages/PublicPayThanksPage';
import PublicEstimateViewPage from './pages/PublicEstimateViewPage';
import RatePage from './pages/RatePage';
import TechnicianPhotosPage from './pages/TechnicianPhotosPage';
import ApiDocsPage from './pages/ApiDocsPage';
import LeadFormSettingsPage from './pages/LeadFormSettingsPage';
import SuperAdminPage from './pages/SuperAdminPage';
import AdminCompanyDetailPage from './pages/AdminCompanyDetailPage';
import CompanyUsersPage from './pages/CompanyUsersPage';
import RolesAccessPage from './pages/RolesAccessPage';
import QuickMessagesPage from './pages/QuickMessagesPage';
import PaymentsPage from './pages/PaymentsPage';
import ActionRequiredSettingsPage from './pages/ActionRequiredSettingsPage';
import AutomationPage from './pages/AutomationPage';
import BillingPage from './pages/BillingPage';
import GoogleEmailSettingsPage from './pages/GoogleEmailSettingsPage';
import TelephonyTwilioSettingsPage from './pages/TelephonyTwilioSettingsPage';
import DocumentTemplatesPage from './pages/DocumentTemplatesPage';
import PriceBookPage from './pages/PriceBookPage';
import DocumentTemplateEditorPage from './pages/DocumentTemplateEditorPage';
import { EmailPage } from './pages/EmailPage';
import ServiceTerritoriesPage from './pages/ServiceTerritoriesPage';
import JobsPage from './pages/JobsPage';
import { SchedulePage } from './pages/SchedulePage';
import EstimatesPage from './pages/EstimatesPage';
import InvoicesPage from './pages/InvoicesPage';
import TasksPage from './pages/TasksPage';
import TransactionsPage from './pages/TransactionsPage';
import RouteManagerOverviewPage from './pages/telephony/RouteManagerOverviewPage';
import CallFlowBuilderPage from './pages/telephony/CallFlowBuilderPage';
import WorkflowBuilderPage from './pages/workflows/WorkflowBuilderPage';
import PhoneNumbersPage from './pages/telephony/PhoneNumbersPage';
import AudioLibraryPage from './pages/telephony/AudioLibraryPage';
import ProviderSettingsPage from './pages/telephony/ProviderSettingsPage';
import RoutingLogsPage from './pages/telephony/RoutingLogsPage';
import OperationsDashboardPage from './pages/telephony/OperationsDashboardPage';
import UserGroupsPage from './pages/telephony/UserGroupsPage';
import UserGroupDetailPage from './pages/telephony/UserGroupDetailPage';
import BlacklistPage from './pages/telephony/BlacklistPage';
import CompanySchedulePage from './pages/CompanySchedulePage';
import BankTransferDetailsPage from './pages/BankTransferDetailsPage';

import TelephonyLayout from './components/telephony/TelephonyLayout';
import SettingsLayout from './components/settings/SettingsLayout';
import { SettingsLandingRedirect } from './components/settings/SettingsLandingRedirect';
import { EventNotification } from './components/EventNotification';
import NotificationReminderBanner from './components/NotificationReminderBanner';
import SSEPushBridge from './components/SSEPushBridge';
import { Toaster } from './components/ui/sonner';
import { OverlayStackProvider } from './components/ui/OverlayStack';
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
          <OverlayStackProvider>
          <OnboardingGate />
          <TwoFactorGate />
          <AppLayout>
            <Routes>
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/pay/thanks" element={<PublicPayThanksPage />} />
              <Route path="/pay/:token" element={<PublicInvoicePayPage />} />
              <Route path="/e/:token" element={<PublicEstimateViewPage />} />
              <Route path="/r/:token" element={<RatePage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/" element={<Navigate to="/pulse" replace />} />
              <Route path="/pulse" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/welcome" element={<ProtectedRoute permissions={['pulse.view']}><WelcomePage /></ProtectedRoute>} />
              <Route path="/pulse/contact/:id" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/pulse/timeline/:id" element={<ProtectedRoute permissions={['pulse.view']}><PulsePage /></ProtectedRoute>} />
              <Route path="/calls" element={<ProtectedRoute permissions={['messages.view_internal']}><HomePage /></ProtectedRoute>} />
              <Route path="/contact/:id" element={<ProtectedRoute permissions={['messages.view_internal']}><ConversationPage /></ProtectedRoute>} />
              <Route path="/calls/:callSid" element={<ProtectedRoute permissions={['messages.view_internal']}><ConversationPage /></ProtectedRoute>} />
              <Route path="/messages" element={<ProtectedRoute permissions={['messages.view_internal']}><MessagesPage /></ProtectedRoute>} />
              <Route path="/leads" element={<ProtectedRoute permissions={['leads.view']}><LeadsPage /></ProtectedRoute>} />
              <Route path="/leads/:leadId" element={<ProtectedRoute permissions={['leads.view']}><LeadsPage /></ProtectedRoute>} />
              <Route path="/jobs" element={<ProtectedRoute permissions={['jobs.view']}><JobsPage /></ProtectedRoute>} />
              <Route path="/jobs/:jobId" element={<ProtectedRoute permissions={['jobs.view']}><JobsPage /></ProtectedRoute>} />
              <Route path="/schedule" element={<ProtectedRoute permissions={['schedule.view']}><SchedulePage /></ProtectedRoute>} />
              <Route path="/tasks" element={<ProtectedRoute permissions={['tasks.view']}><TasksPage /></ProtectedRoute>} />
              <Route path="/estimates" element={<ProtectedRoute permissions={['estimates.view']}><EstimatesPage /></ProtectedRoute>} />
              <Route path="/invoices" element={<ProtectedRoute permissions={['invoices.view']}><InvoicesPage /></ProtectedRoute>} />
              <Route path="/contacts" element={<ProtectedRoute permissions={['contacts.view']}><ContactsPage /></ProtectedRoute>} />
              <Route path="/contacts/:contactId" element={<ProtectedRoute permissions={['contacts.view']}><ContactsPage /></ProtectedRoute>} />
              
              <Route path="/settings" element={<SettingsLandingRedirect />} />
              <Route path="/settings/action-required" element={<Navigate to="/settings/actions-notifications" replace />} />
              <Route path="/settings/email" element={<Navigate to="/settings/integrations/google-email" replace />} />

              {/* Fullscreen settings surfaces — stay OUTSIDE SettingsLayout: API docs,
                  the document-template editor (its list page is inside), the call-flow
                  builder, and the workflow builder. */}
              <Route path="/settings/api-docs" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><ApiDocsPage /></ProtectedRoute>} />
              <Route path="/settings/document-templates/:id" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><DocumentTemplateEditorPage /></ProtectedRoute>} />

              {/* Settings — persistent left sub-nav (UI-AUDIT-001 W4, variant C).
                  Pathless layout route: SettingsLayout renders the sidebar + <Outlet/>;
                  the per-route ProtectedRoute guards are unchanged. */}
              <Route element={<SettingsLayout />}>
                <Route path="/settings/business" element={<SettingsLandingRedirect groupId="business" />} />
                <Route path="/settings/scheduling" element={<SettingsLandingRedirect groupId="scheduling" />} />
                <Route path="/settings/jobs" element={<SettingsLandingRedirect groupId="jobs" />} />
                <Route path="/settings/phone-ai" element={<SettingsLandingRedirect groupId="phone-ai" />} />
                <Route path="/settings/billing-payments" element={<SettingsLandingRedirect groupId="billing-payments" />} />
                <Route path="/settings/apps-integrations" element={<SettingsLandingRedirect groupId="apps-integrations" />} />
                <Route path="/settings/team-access" element={<SettingsLandingRedirect groupId="team-access" />} />
                <Route path="/settings/alerts-notifications" element={<SettingsLandingRedirect groupId="alerts-notifications" />} />
                <Route path="/settings/billing-group" element={<SettingsLandingRedirect groupId="billing" />} />
                <Route path="/settings/platform-administration" element={<SettingsLandingRedirect groupId="platform-administration" />} />
                <Route path="/settings/company" element={<ProtectedRoute permissions={['tenant.company.manage']}><CompanySettingsPage /></ProtectedRoute>} />
                <Route path="/settings/scheduling/company-schedule" element={<ProtectedRoute permissions={['schedule.dispatch', 'tenant.company.manage']}><CompanySchedulePage /></ProtectedRoute>} />
                <Route path="/settings/users" element={<ProtectedRoute permissions={['tenant.users.manage']}><CompanyUsersPage /></ProtectedRoute>} />
                <Route path="/settings/roles" element={<ProtectedRoute permissions={['tenant.roles.manage']}><RolesAccessPage /></ProtectedRoute>} />
                <Route path="/settings/billing" element={<ProtectedRoute permissions={['tenant.company.manage']}><BillingPage /></ProtectedRoute>} />
                <Route path="/settings/billing/bank-transfer-details" element={<ProtectedRoute permissions={['tenant.company.manage']}><BankTransferDetailsPage /></ProtectedRoute>} />
                <Route path="/settings/actions-notifications" element={<ProtectedRoute permissions={['tenant.company.manage']}><ActionRequiredSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/lead-form" element={<ProtectedRoute permissions={['tenant.company.manage']}><LeadFormSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/quick-messages" element={<ProtectedRoute permissions={['tenant.company.manage']}><QuickMessagesPage /></ProtectedRoute>} />
                <Route path="/settings/price-book" element={<ProtectedRoute permissions={['price_book.manage']}><PriceBookPage /></ProtectedRoute>} />
                <Route path="/settings/service-territories" element={<ProtectedRoute permissions={['tenant.company.manage']}><ServiceTerritoriesPage /></ProtectedRoute>} />
                <Route path="/settings/document-templates" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><DocumentTemplatesPage /></ProtectedRoute>} />
                <Route path="/settings/automation" element={<ProtectedRoute permissions={['tenant.company.manage']}><AutomationPage /></ProtectedRoute>} />
                <Route path="/settings/providers" element={<Navigate to="/settings/technicians" replace />} />
                <Route path="/settings/technicians" element={<ProtectedRoute permissions={['tenant.company.manage']}><TechnicianPhotosPage /></ProtectedRoute>} />
                {/* Telephony pages share the Settings shell. TelephonyLayout now owns
                    only the existing connection gate; Phone system is their parent
                    subsection in the shared navigation model. */}
                <Route path="/settings/telephony" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><RouteManagerOverviewPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/user-groups" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><UserGroupsPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/user-groups/:groupId" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><UserGroupDetailPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/phone-numbers" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><PhoneNumbersPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/audio-library" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><AudioLibraryPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/blacklist" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><BlacklistPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/provider-settings" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><ProviderSettingsPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/routing-logs" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><RoutingLogsPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/telephony/dashboard" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><TelephonyLayout><OperationsDashboardPage /></TelephonyLayout></ProtectedRoute>} />
                <Route path="/settings/integrations" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><IntegrationsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/vapi-ai" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><VapiSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/mail-secretary" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><MailSecretarySettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/outbound-lead-caller" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><OutboundLeadCallerSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/outbound-parts-caller" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><OutboundPartsCallerSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/stripe-payments" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><StripePaymentsSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/google-email" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><GoogleEmailSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/integrations/telephony-twilio" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><TelephonyTwilioSettingsPage /></ProtectedRoute>} />
                <Route path="/settings/admin" element={<ProtectedRoute platformRoles={['super_admin']}><SuperAdminPage /></ProtectedRoute>} />
                <Route path="/settings/admin/companies/:companyId" element={<ProtectedRoute platformRoles={['super_admin']}><AdminCompanyDetailPage /></ProtectedRoute>} />
              </Route>
              
              <Route path="/payments" element={<ProtectedRoute permissions={['payments.view']}><PaymentsPage /></ProtectedRoute>} />
              <Route path="/payments/:paymentId" element={<ProtectedRoute permissions={['payments.view']}><PaymentsPage /></ProtectedRoute>} />
              <Route path="/transactions" element={<ProtectedRoute permissions={['payments.view']}><TransactionsPage /></ProtectedRoute>} />
              
              <Route path="/email" element={<ProtectedRoute permissions={['messages.view_internal']}><EmailPage /></ProtectedRoute>} />

              {/* Call Flow Builder — full-screen contextual Phone system route,
                  accessed from User Group detail. */}
              <Route path="/settings/telephony/user-groups/:groupId/flow" element={<ProtectedRoute permissions={['tenant.telephony.manage']}><CallFlowBuilderPage /></ProtectedRoute>} />

              {/* Workflow Builder — full-screen visual FSM editor */}
              <Route path="/settings/workflows/:machineKey" element={<ProtectedRoute permissions={['tenant.company.manage']}><WorkflowBuilderPage /></ProtectedRoute>} />

              {/* Backward-compatible operations URL */}
              <Route path="/calls/dashboard" element={<Navigate to="/settings/telephony/dashboard" replace />} />

            </Routes>
          </AppLayout>
          <EventNotification />
          <NotificationReminderBanner />
          <SSEPushBridge />
          <Toaster />
          </OverlayStackProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
