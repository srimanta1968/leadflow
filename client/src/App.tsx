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
              <Route path="analytics" element={<Analytics />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
