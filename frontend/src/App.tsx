import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './components/layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { ConversationPage } from './pages/ConversationPage';
import { LeadsPage } from './pages/LeadsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import ApiDocsPage from './pages/ApiDocsPage';
import LeadFormSettingsPage from './pages/LeadFormSettingsPage';
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Navigate to="/calls" replace />} />
            <Route path="/calls" element={<HomePage />} />
            <Route path="/contact/:id" element={<ConversationPage />} />
            <Route path="/calls/:callSid" element={<ConversationPage />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/integrations" replace />} />
            <Route path="/settings/integrations" element={<IntegrationsPage />} />
            <Route path="/settings/api-docs" element={<ApiDocsPage />} />
            <Route path="/settings/lead-form" element={<LeadFormSettingsPage />} />
          </Routes>
        </AppLayout>
        <EventNotification />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;

