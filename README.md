# Dispatch Control Room

A locally hosted dispatch system with a full-width operations map and an installable field view. Operational records are persisted through the Node server to Supabase Postgres; authentication is handled by Supabase Auth. The browser never receives the Supabase service-role key. Public registration is not part of the app: create the first account in Supabase Auth, then any signed-in operator can provision additional accounts. All authenticated users have equal access; there are no Dispatch administrator roles.

## Open and run in VS Code

After cloning the published branch, open the `dispatch` folder in VS Code. Copy `.env.example` to `.env`, fill in your **rotated** Supabase project URL, anon key, and service-role key, then run `supabase/schema.sql` in the Supabase SQL Editor. In VS Code, press **F5** and choose **Dispatch — local Supabase backend**, or run **Terminal → Run Task → Dispatch: start locally**. The local launch configuration binds to `127.0.0.1:3000`; it does not expose the development server to your LAN. The `.env` file is ignored by Git and must never be committed. For local traffic demos, set `TOMTOM_API_KEY` in that local `.env`; the server uses it for proxied TomTom flow/tile requests without requiring a Dispatch account. The environment key takes precedence over a key stored in Supabase settings and is never returned to the browser. Do not paste it into tracked source files.

## Supabase setup (required)

1. **Rotate the Supabase keys previously shared in chat.** Treat them as exposed. Do not reuse or paste replacement secrets into chat, source files, screenshots, or Git.
2. In Supabase, run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor. It creates the protected state and backup tables. RLS is enabled, and direct `anon`/`authenticated` access is revoked; only the server's service-role key uses these tables.
3. In Supabase Authentication settings, disable **Allow new users to sign up**. The app has no public sign-up route. Signed-in operators can create accounts from **Settings → User access** after the first account is established.
4. Create the first user in Supabase Authentication and confirm the email. No Dispatch role promotion or SQL metadata edit is required. All signed-in users receive the same application access.
5. Copy `.env.example` to `.env` (ignored by Git) and fill in the **rotated** project URL, anon key, and service-role key. Never put the service-role key in frontend code. The app does not need the Supabase JWT signing secret.
6. Use HTTPS for sign-in outside localhost. Terminate TLS at a trusted reverse proxy and set `DISPATCH_TRUST_PROXY=true` only when the proxy is the trusted entry point. For local-only HTTP development, explicitly set `DISPATCH_COOKIE_SECURE=false`; do not use that setting on a network-facing server.
7. Start the server with Node.js 20 or newer:

   ```sh
   npm start
   ```

   Open `http://localhost:3000` for local development, or the HTTPS URL of your trusted proxy. If the Supabase state table is empty, the first successful server start imports the existing ignored `data/dispatch.json` once (or initializes the demo seed if there is no file). After that, Supabase is the source of truth; the server does not write operational data back to the local JSON file. If the table is unavailable or credentials are missing, the app stays locked and shows a setup message.

### Vercel deployment

The repository's Vercel Node Function adapter serves the frontend assets from the deployed bundle and routes API requests through the same application server. Link the GitHub repository with `main` as its production branch. Before deploying, run the full current `supabase/schema.sql` in the Supabase SQL Editor, then add these values under the Vercel project's Environment Variables (do not share the service-role key in chat): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `DISPATCH_COOKIE_SECURE=true`. Optionally add `TOMTOM_API_KEY` for live traffic. Redeploy after adding variables. Without the three Supabase values, sign-in and persisted operations cannot work.

The Vercel adapter stores shared state and WebRTC signaling in Supabase and uses a database lock for writes across function instances. Vercel functions are ephemeral, so maintenance (offline-timeout alerts, scheduled messages, retention cleanup, and hourly automatic backups) runs opportunistically on active write/heartbeat requests rather than on a continuous timer; it pauses when there is no app traffic. Manual backups remain available after Supabase is configured.

### First account and user access

Create the first login in Supabase Auth, then sign in and use **Settings → User access** to create additional accounts with a temporary password (minimum 14 characters). All authenticated users have identical full application access; there are no application administrator roles. Keep accounts limited to trusted people because each can change settings and users, delete records, and manage backups. Users can change their password in Settings. Do not send temporary passwords over public channels. User creation is performed server-side through Supabase's privileged Auth API; no public sign-up is enabled.

## Data model and security

The existing system state—including roster, sites, alerts, messages, call records, recordings, traffic samples, GPS histories used by Day Review, audit records, and settings—is stored together as JSONB in the protected `dispatch_state` row. Supabase-backed snapshots are stored in `dispatch_backups`. Writes are serialized locally and with a Supabase lease lock for Vercel function instances; this keeps the existing JSON-state model consistent across concurrent functions, though transactional per-entity storage would be preferable at larger scale. Supabase Auth stores user credentials; the app never stores passwords.

All `/api/*` operations other than the minimal auth status/login/logout routes require a verified Supabase session. Session tokens are held in HttpOnly, SameSite cookies; login attempts are rate-limited; sign-up is not exposed; all authenticated users have the same operational, account-management, and backup/restore permissions; there is no application role hierarchy. HTTPS is required by default for non-local sign-in. Keep the Node service behind a trusted TLS proxy and firewall; do not expose the service-role key or an unprotected port. The Supabase service-role key bypasses RLS, so keep it only in server-side environment variables (the ignored local `.env` file or the Vercel project's protected Environment Variables).

The app persists call/session records and saved recordings; live WebRTC audio is still an ephemeral peer-to-peer stream and is not itself written to the database unless a local microphone recording is explicitly saved. Basemap tiles are fetched from their map providers, not stored in Supabase. In the browser client, TomTom flow samples and raster traffic tiles are proxied through the authenticated Dispatch server, so the TomTom key is not placed in browser traffic-tile URLs. The Android WebView continues to request TomTom raster tiles directly because its app-assets origin cannot use the browser's same-origin tile proxy.

## Exercise the system

1. From Live operations, choose **Start route simulation**. Clocked-in demo units move around their assigned sites and the server stores their timestamped simulated fixes. Stop the simulation with the same control.
2. Open **Field** in a second tab, sign in with a provisioned user, clock in, and grant location permission to share device GPS. Offline fixes queue for retry.
3. For voice, start a private/group/all call from **Voice dispatch**, accept it in the Field view, and grant microphone permission. Calls require another signed-in, on-shift Field client to be connected; public STUN discovery is enabled for direct peer connections, but no TURN relay or SIP/PBX gateway is bundled, so restrictive networks may still block audio. Microphone use outside localhost requires a secure context.
4. **Record local mic** captures a consented local microphone clip for playback; it does not silently record remote call audio.

## Diagnostics and bug reports

The local **Diagnostics** control records app-level function calls, UI actions, API outcomes, map errors, and server request status without capturing form values or secrets. Logs remain local; choose **Diagnostics → Download log** to create a JSON file you can attach to a bug report. See [DIAGNOSTICS.md](DIAGNOSTICS.md) for the full privacy notes and workflow.

## Android field APK

The native Android project is under `android/`. The APK is a lightweight field tracker only: sign-in, unit and shift selection, online/offline presence, background GPS, SOS, Dispatch app messages, and live in-app voice to control. It does not bundle the operations console, maps, reports, settings, or control-room tools. A fresh install defaults to `https://dispatch-brown-five.vercel.app`; use the **Server** button to change it. Messages are Dispatch app messages (not carrier SMS), and voice calls are in-app WebRTC calls (not cellular calls). Location uses Android GPS while clocked in and online, and queues fixes while connectivity is unavailable. The phone must reach the server over HTTPS when secure cookies are enabled. Do not use `localhost` on a physical phone. To refresh the small Android-only UI bundle, run `./scripts/sync-android-assets.sh`. Build with JDK 17 and Android SDK Platform 35:

```sh
cd android
./gradlew :app:assembleDebug
```

No prebuilt APK is included. This workspace has no JDK or Android SDK, so the APK has not been compiled here.

## Maps, archive and workflows

- The map provides Street, Satellite and Topographic basemaps, 2D and pitched 3D perspectives, site/unit overlays, map-based geofence drawing, fit-to-units, geolocation, measurement and fullscreen. The 3D view is a pitched camera only; there is no terrain or building model layer. If the primary external street tiles fail, the map tries OpenStreetMap and reports a connection issue if tiles remain unavailable. No synthetic or locally hosted road map is included.
- TomTom flow tiles remain full-color and require a configured key and provider attribution. Traffic history is sampled near configured work sites and stored in the Supabase state record; it is not a full historical street-network feed.
- Day Review uses the same replay time for recorded traffic and GPS fixes. It does not invent positions or readings. A date without GPS fixes will show no fabricated unit locations.
- The app includes roster/groups, shifts, alerts and SOS, dispatch messaging, WebRTC call history, recordings, relay/telemetry simulations, reports/CSV, audit history, and Supabase-backed backups/restore. Field-to-control calls ring connected control consoles automatically; the first controller to answer takes the call. Authenticated field sessions heartbeat their online presence independently of GPS, and the configured offline threshold governs disconnect alerts. SOS reports store the press time, last-known and subsequent GPS fixes, accuracy, unit health, and connection state; dashboard SOS actions jump to the live unit position.
- Physical radios, telemetry outputs, SIP/PSTN, external email delivery, and hardware control require separate integrations. Current radio/relay/output controls are local simulations/configuration only.

## API notes

Operational API routes require an authenticated cookie. Important routes include `GET /api/state`, `POST /api/action`, `POST /api/ingest/location`, `POST /api/traffic`, `POST /api/traffic/sample` (server-side TomTom flow sampling), `GET /api/traffic/tiles/flow/relative/{z}/{x}/{y}.png` (short-lived cached TomTom tile proxy), `GET /api/export`, `POST /api/backup`, `GET /api/backups`, and `POST /api/restore`. Public auth routes are limited to `GET /api/auth/status`, `POST /api/auth/login`, and `POST /api/auth/logout`; the user-management endpoints require a verified session.
