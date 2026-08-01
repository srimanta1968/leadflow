import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where `/api` requests are forwarded. Overridable so the server can be moved to
 * another port (after a clash, say) without editing this file — the two must
 * agree or every API call from the app 404s against the dev server itself.
 */
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3010';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // FAIL rather than silently moving to 5174. A drifting port looks harmless
    // in the log but breaks two things that hard-code 5173: the UI base URL in
    // tests/config/test-config.json, and the CORS allow-list in server/src/app.ts.
    // A clear startup failure is far cheaper to diagnose than a suite that runs
    // against a port nothing is serving.
    strictPort: true,
    // Bind all interfaces, not just loopback. The Playwright/BDD test runner
    // drives the app from inside a container and reaches the host through
    // host.docker.internal, which a 127.0.0.1-only listener refuses — the UI
    // suite cannot run at all without this.
    host: true,
    // Binding all interfaces is not sufficient on its own: since 5.4.12 Vite
    // also checks the *Host header* and answers anything unlisted with a plain
    // 403 "Blocked request" body. The BDD runner reaches the dev server as
    // host.docker.internal, so without this entry every scenario fails on its
    // very first navigate step — on every page, not just one — while a curl
    // pre-flight from the same container still passes, because the block is a
    // 403 response rather than a refused connection.
    //
    // Enumerated rather than set to `true`: `true` disables the DNS-rebinding
    // protection outright, which would let any site a developer visits reach
    // this dev server through a rebound name.
    allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal'],
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
