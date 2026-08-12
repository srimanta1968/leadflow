import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from './context/SessionContext';
import { ToastProvider } from './components/feedback/ToastProvider';
import { MarketingLayout } from './components/marketing/MarketingLayout';
import { AppShell } from './components/app/AppShell';
import { RequireSession } from './components/app/RequireSession';

import Home from './pages/marketing/Home';
import Product from './pages/marketing/Product';
import Solutions from './pages/marketing/Solutions';
import Security from './pages/marketing/Security';
import Pricing from './pages/marketing/Pricing';
import Demo from './pages/marketing/Demo';
import SignIn from './pages/auth/SignIn';
import SignUp from './pages/auth/SignUp';
import CaptureInbox from './pages/app/CaptureInbox';
import LeadQueue from './pages/app/LeadQueue';
import QuickCapture from './pages/app/QuickCapture';
import RoutingRules from './pages/app/RoutingRules';
import SlaSettings from './pages/app/SlaSettings';
import Analytics from './pages/app/Analytics';
import ImportCenter from './pages/app/ImportCenter';
import IdentityReview from './pages/app/IdentityReview';
import ConsentPreferences from './pages/app/ConsentPreferences';
import EnrichmentQueue from './pages/app/EnrichmentQueue';
import DataReview from './pages/app/DataReview';
import Contacts from './pages/app/Contacts';
import Contact360 from './pages/app/Contact360';
import AuditHistory from './pages/app/AuditHistory';
import RoutingConfiguration from './pages/app/RoutingConfiguration';
import CoverageConsole from './pages/app/CoverageConsole';
import RoutingSimulation from './pages/app/RoutingSimulation';
import Pipeline from './pages/app/Pipeline';
import Inbox from './pages/app/Inbox';
import Calendar from './pages/app/Calendar';
import CommercialReview from './pages/app/CommercialReview';
import OnboardingHandoff from './pages/app/OnboardingHandoff';
import CampaignEnrollment from './pages/app/CampaignEnrollment';
import LeadershipDashboard from './pages/app/LeadershipDashboard';
import RoleDashboards from './pages/app/RoleDashboards';
import WorkflowStudio from './pages/app/WorkflowStudio';
import WorkflowRuns from './pages/app/WorkflowRuns';
import Incidents from './pages/app/Incidents';
import Governance from './pages/app/Governance';
import Sequences from './pages/app/Sequences';
import Templates from './pages/app/Templates';
import UserAdministration from './pages/app/UserAdministration';
import PermissionMatrixScreen from './pages/app/PermissionMatrixScreen';
import TrainingCentre from './pages/app/TrainingCentre';
import NotFound from './pages/NotFound';

/**
 * Route table.
 *
 * Three zones with different chrome: the public marketing site under
 * `MarketingLayout`, the bare auth screens, and the signed-in application under
 * `AppShell` behind `RequireSession`.
 *
 * `ToastProvider` wraps `SessionProvider` so that session events — an expired
 * token dropping the user out — can raise a message while unwinding.
 */
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Routes>
            {/* Public marketing site */}
            <Route element={<MarketingLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/product" element={<Product />} />
              <Route path="/solutions" element={<Solutions />} />
              <Route path="/security" element={<Security />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/demo" element={<Demo />} />
            </Route>

            {/* Auth */}
            <Route path="/signin" element={<SignIn />} />
            <Route path="/signup" element={<SignUp />} />

            {/* Signed-in application */}
            <Route
              path="/app"
              element={
                <RequireSession>
                  <AppShell />
                </RequireSession>
              }
            >
              <Route index element={<CaptureInbox />} />
              <Route path="leads" element={<LeadQueue />} />
              <Route path="capture" element={<QuickCapture />} />
              <Route path="routing" element={<RoutingRules />} />
              <Route path="sla" element={<SlaSettings />} />
              <Route path="import" element={<ImportCenter />} />
              <Route path="identity" element={<IdentityReview />} />
              <Route path="consent" element={<ConsentPreferences />} />
              <Route path="enrichment" element={<EnrichmentQueue />} />
              <Route path="data-review" element={<DataReview />} />
              <Route path="analytics" element={<Analytics />} />

              {/*
                Contact 360 is one screen with eight DEEP-LINKABLE tabs, so the
                tab is a route segment rather than component state. The bare
                /app/contacts/:id form redirects into the default tab so a link
                without a segment still lands on a real pane instead of an empty
                workspace.
              */}
              <Route path="contacts" element={<Contacts />} />
              <Route path="contacts/:contactId" element={<Contact360 />} />
              <Route path="contacts/:contactId/:tab" element={<Contact360 />} />

              <Route path="audit" element={<AuditHistory />} />
              <Route path="routing-config" element={<RoutingConfiguration />} />
              <Route path="coverage" element={<CoverageConsole />} />
              <Route path="routing-simulation" element={<RoutingSimulation />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="calendar" element={<Calendar />} />
              <Route path="offers" element={<CommercialReview />} />
              <Route path="handoffs" element={<OnboardingHandoff />} />
              <Route path="campaigns" element={<CampaignEnrollment />} />
              <Route path="leadership" element={<LeadershipDashboard />} />
              {/* The role is a route segment so each dashboard is linkable. */}
              <Route path="dashboards" element={<RoleDashboards />} />
              <Route path="dashboards/:role" element={<RoleDashboards />} />
              <Route path="workflows" element={<WorkflowStudio />} />
              <Route path="workflow-runs" element={<WorkflowRuns />} />
              <Route path="incidents" element={<Incidents />} />
              <Route path="governance" element={<Governance />} />
              <Route path="sequences" element={<Sequences />} />
              <Route path="templates" element={<Templates />} />

              {/*
                Administration. The permission matrix component has existed for
                some time and was never routed — unreachable dead code beside a
                product where three screens were Locked for everybody because
                nobody could grant the roles that unlock them.
              */}
              <Route path="admin/users" element={<UserAdministration />} />
              <Route path="admin/permissions" element={<PermissionMatrixScreen />} />

              {/*
                The guide is a route segment rather than component state so the
                Guide button in the top bar can deep-link straight to the card
                for the screen the operator is stuck on.
              */}
              <Route path="training" element={<TrainingCentre />} />
              <Route path="training/:guideId" element={<TrainingCentre />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
