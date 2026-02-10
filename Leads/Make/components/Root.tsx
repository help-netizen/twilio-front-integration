import { Outlet, Link, useLocation } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Phone, Users } from "lucide-react";

export function Root() {
  const location = useLocation();
  const currentTab = location.pathname === '/leads' ? 'leads' : 'calls';

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="flex items-center gap-6 px-6 py-4">
          <h1 className="text-2xl font-semibold">Blanc</h1>
          
          {/* Navigation Tabs */}
          <Tabs value={currentTab} className="w-auto">
            <TabsList>
              <TabsTrigger value="calls" className="flex items-center gap-2" asChild>
                <Link to="/calls">
                  <Phone className="size-4" />
                  Calls
                </Link>
              </TabsTrigger>
              <TabsTrigger value="leads" className="flex items-center gap-2" asChild>
                <Link to="/leads">
                  <Users className="size-4" />
                  Leads
                </Link>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}