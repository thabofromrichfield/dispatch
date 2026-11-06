# Dispatch Control Room

## [⬇ Download the Android Field App](https://github.com/thabofromrichfield/dispatch/releases/latest/download/Dispatch-Field.apk)

Field-only phone app: background GPS, online/offline, SOS, Dispatch messages, and live voice. The APK does not contain the control-room console.

A live dispatch system with a lightweight operations dashboard and field-only Android app. Fresh state starts empty: units, sites, alerts, messages, and locations appear only when operators create them or authenticated devices report them. Operators can provision operator accounts or a field login bound to exactly one unit. Field state and GPS archive rows are protected by Supabase row-level security and server-side scope checks.

## Open and run in VS Code

After cloning the published branch, open the `dispatch` folder in VS Code. Copy `.env.example` to `.env`, fill in your **rotated** Supabase project URL, anon key, and service-role key, then run `supabase/schema.sql` in the Supabase SQL Editor. In VS Code, press **F5** and choose **Dispatch — local Supabase backend**, or run **Terminal → Run Task → Dispatch: start locally**. The local launch configuration binds to `127.0.0.1:3000`; it does not expose the development server to your LAN. The `.env` file is ignored by Git and must never be committed. For local traffic demos, set `TOMTOM_API_KEY` in that local `.env`; the server uses it for proxied TomTom flow/tile requests without requiring a Dispatch account. The environment key takes precedence over a key stored in Supabase settings and is never returned to the browser. Do not paste it into tracked source files.

## Supabase setup (required)

1. In Supabase, run the current [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor before deploying this version. It migrates legacy GPS history into an indexed archive, creates unit identity/state tables, enables per-unit RLS, and installs the compact state/GPS save functions. The dashboard shows whether this migration is ready. Do not skip it: old history is preserved until it is applied.
2. Keep `anon` and `service_role` keys in protected server configuration only. Never put the service-role key in browser or Android assets.
3. In Supabase Authentication settings, disable **Allow new users to sign up**. The app has no public sign-up route. Signed-in operators can create additional accounts from **Settings → Unit accounts & access** after the first account is established.
4. Create the first control-room operator in Supabase Authentication and confirm the email. After sign-in, use Units → Add unit to create a unit and (optionally) its field login in one flow. Field accounts are linked to one unit and do not receive operator access.
5. Copy `.env.example` to `.env` (ignored by Git) and fill in the **rotated** project URL, anon key, and service-role key. Never put the service-role key in frontend code. The app does not need the Supabase JWT signing secret.
6. Use HTTPS for sign-in outside localhost. Terminate TLS at a trusted reverse proxy and set `DISPATCH_TRUST_PROXY=true` only when the proxy is the trusted entry point. For local-only HTTP development, explicitly set `DISPATCH_COOKIE_SECURE=false`; do not use that setting on a network-facing server.
7. Start the server with Node.js 20 or newer:

   ```sh
   npm start
   ```

   Open `http://localhost:3000` for local development, or the HTTPS URL of your trusted proxy. If the Supabase state table is empty, the first successful server start imports the existing ignored `data/dispatch.json` once (or initializes a clean live state with no units, sites, alerts, messages, or simulated locations). After that, Supabase is the source of truth; the server does not write operational data back to the local JSON file. If the table is unavailable or credentials are missing, the app stays locked and shows a setup message.

### Vercel deployment

The repository's Vercel Node Function adapter serves the frontend assets from the deployed bundle and routes API requests through the same application server. Link the GitHub repository with `main` as its production branch. Before deploying, run the full current `supabase/schema.sql` in the Supabase SQL Editor, then add these values under the Vercel project's Environment Variables (do not share the service-role key in chat): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `DISPATCH_COOKIE_SECURE=true`. Optionally add `TOMTOM_API_KEY` for live traffic. Redeploy after adding variables. Without the three Supabase values, sign-in and persisted operations cannot work.

The Vercel adapter stores shared state and WebRTC signaling in Supabase and uses a database lock for writes across function instances. Vercel functions are ephemeral, so maintenance (offline-timeout alerts, scheduled messages, retention cleanup, and hourly automatic backups) runs opportunistically on active write/heartbeat requests rather than on a continuous timer; it pauses when there is no app traffic. Manual backups remain available after Supabase is configured.

### First account and user access

Create the first operator login in Supabase Auth. Signed-in operators can create control-room accounts in **Settings → Unit accounts & access** and unit-bound credentials from **Units → Add unit**. Temporary passwords must be at least 14 characters; the app never stores them in Dispatch state. Field users sign into the Android Field app and receive only their mapped unit projection. Password changes remain available after sign-in. Public sign-up stays disabled.

## Data model and security

The operator state remains a compact JSONB snapshot in protected `dispatch_state`. GPS fixes are stored separately in indexed `dispatch_locations`; the dashboard reads the archive through a bounded database function rather than loading every fix into the hot state payload. `dispatch_unit_state` contains one small read projection per unit and is protected by RLS against `dispatch_unit_accounts`. Field JWTs can select only their own projection and location rows; the server independently binds field actions and location uploads to the same mapped officer. Service-role access stays server-only. Snapshot and GPS writes are committed together, and concurrent Vercel writes use the database lease lock. Supabase Auth stores user credentials; the app never stores passwords.

All `/api/*` operations other than the minimal auth status/login/logout routes require a verified Supabase session. Session tokens are held in HttpOnly, SameSite cookies; login attempts are rate-limited; sign-up is not exposed; control-room operators have full operational and account-management access; field accounts are restricted to one assigned unit, its relevant messages/alerts, and its row-level state/GPS records. Field requests are also checked by the server, so a field account cannot obtain operator state, reports, recordings, or backups. HTTPS is required by default for non-local sign-in. Keep the Node service behind a trusted TLS proxy and firewall; do not expose the service-role key or an unprotected port. The Supabase service-role key bypasses RLS, so keep it only in server-side environment variables (the ignored local `.env` file or the Vercel project's protected Environment Variables).

The app persists call/session records and saved recordings; live WebRTC audio is still an ephemeral peer-to-peer stream and is not itself written to the database unless a local microphone recording is explicitly saved. Basemap tiles are fetched from their map providers, not stored in Supabase. In the browser client, TomTom flow samples and raster traffic tiles are proxied through the authenticated Dispatch server, so the TomTom key is not placed in browser traffic-tile URLs. The Android field APK does not include maps or traffic tiles.

## Exercise the system

1. **Live mode is the default.** From Live operations, use **LIVE MODE ON** to stop any old route simulation and remove identified seed/sample records while preserving real units and real GPS history. Simulation controls and simulated telemetry/config writes are disabled in live mode.
2. Create a unit, assign its work site, add its field login, then sign in from the Android Field app. Clock in and allow location access; only real device reports update its live location. Offline fixes queue for retry.
3. For voice, start a private/group/all call from **Voice dispatch**, accept it in the Field app, and grant microphone permission. Calls require another signed-in, on-shift Field client to be connected; public STUN discovery is enabled for direct peer connections, but no TURN relay or SIP/PBX gateway is bundled, so restrictive networks may still block audio. Microphone use outside localhost requires a secure context.
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
- The app includes roster/groups, shifts, alerts and SOS, dispatch messaging, WebRTC call history, recordings, live device health, reports/CSV, audit history, and Supabase-backed backups/restore. Synthetic route movement, demo telemetry, and simulated terminal configuration are blocked in live mode. Field-to-control calls ring connected control consoles automatically; the first controller to answer takes the call. Authenticated field sessions heartbeat their online presence independently of GPS, and the configured offline threshold governs disconnect alerts. SOS reports store the press time, last-known and subsequent GPS fixes, accuracy, unit health, and connection state; dashboard SOS actions jump to the live unit position.
- Physical radios, telemetry outputs, SIP/PSTN, external email delivery, and hardware control require separate integrations. Physical radio/relay/output controls require a connected gateway; those synthetic controls remain disabled in live mode.

## API notes

Operational API routes require an authenticated cookie. Important routes include `GET /api/state`, `POST /api/action`, `POST /api/ingest/location`, `POST /api/traffic`, `POST /api/traffic/sample` (server-side TomTom flow sampling), `GET /api/traffic/tiles/flow/relative/{z}/{x}/{y}.png` (short-lived cached TomTom tile proxy), `GET /api/export`, `POST /api/backup`, `GET /api/backups`, and `POST /api/restore`. Public auth routes are limited to `GET /api/auth/status`, `POST /api/auth/login`, and `POST /api/auth/logout`; the user-management endpoints require a verified session.
