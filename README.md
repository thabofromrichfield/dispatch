# Dispatch Control Room

A locally hosted dispatch system with a full-width operations map and an installable field view. Operational records are persisted through the Node server to Supabase Postgres; authentication is handled by Supabase Auth. The browser never receives the Supabase service-role key. Public registration is not part of the app: an administrator provisions users or an operator creates the first account in Supabase and promotes it in `app_metadata`.

## Open and run in VS Code

After cloning the published branch, open the `dispatch` folder in VS Code. Copy `.env.example` to `.env`, fill in your **rotated** Supabase project URL, anon key, and service-role key, then run `supabase/schema.sql` in the Supabase SQL Editor. In VS Code, press **F5** and choose **Dispatch — local Supabase backend**, or run **Terminal → Run Task → Dispatch: start locally**. The local launch configuration binds to `127.0.0.1:3000`; it does not expose the development server to your LAN. The `.env` file is ignored by Git and must never be committed.

## Supabase setup (required)

1. **Rotate the Supabase keys previously shared in chat.** Treat them as exposed. Do not reuse or paste replacement secrets into chat, source files, screenshots, or Git.
2. In Supabase, run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor. It creates the protected state and backup tables. RLS is enabled, and direct `anon`/`authenticated` access is revoked; only the server's service-role key uses these tables.
3. In Supabase Authentication settings, disable **Allow new users to sign up**. The app has no public sign-up route. Administrators can create accounts from **Settings → User access** after the first admin is established.
4. Create the first user in Supabase Authentication. In the SQL Editor, grant administrator access to that user's verified email (replace the example address):

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"dispatch_role":"admin"}'::jsonb
   where lower(email) = lower('admin@example.com');
   ```

5. Copy `.env.example` to `.env` (ignored by Git) and fill in the **rotated** project URL, anon key, and service-role key. Never put the service-role key in frontend code. The app does not need the Supabase JWT signing secret.
6. Use HTTPS for sign-in outside localhost. Terminate TLS at a trusted reverse proxy and set `DISPATCH_TRUST_PROXY=true` only when the proxy is the trusted entry point. For local-only HTTP development, explicitly set `DISPATCH_COOKIE_SECURE=false`; do not use that setting on a network-facing server.
7. Start the server with Node.js 20 or newer:

   ```sh
   npm start
   ```

   Open `http://localhost:3000` for local development, or the HTTPS URL of your trusted proxy. If the Supabase state table is empty, the first successful server start imports the existing ignored `data/dispatch.json` once (or initializes the demo seed if there is no file). After that, Supabase is the source of truth; the server does not write operational data back to the local JSON file. If the table is unavailable or credentials are missing, the app stays locked and shows a setup message.

### First account and user access

The SQL step above establishes the first administrator. Sign in and go to **Settings → User access** to create dispatcher or administrator accounts with a temporary password (minimum 14 characters). Users can change their password in Settings. Do not send temporary passwords over public channels. User creation is performed server-side through Supabase's admin Auth API; no public sign-up is enabled.

## Data model and security

The existing system state—including roster, sites, alerts, messages, call records, recordings, traffic samples, GPS histories used by Day Review, audit records, and settings—is stored together as JSONB in the protected `dispatch_state` row. Supabase-backed snapshots are stored in `dispatch_backups`. The server serializes writes and is intended to run as a **single Node application instance**; do not horizontally scale this JSON-state implementation without replacing it with transactional per-entity storage. Supabase Auth stores user credentials; the app never stores passwords.

All `/api/*` operations other than the minimal auth status/login/logout routes require a verified Supabase session. Session tokens are held in HttpOnly, SameSite cookies; login attempts are rate-limited; sign-up is not exposed; account management and backup/restore are admin-only. HTTPS is required by default for non-local sign-in. Keep the Node service behind a trusted TLS proxy and firewall; do not expose the service-role key or an unprotected port. The Supabase service-role key bypasses RLS, so it must remain exclusively in the ignored server `.env` file.

The app persists call/session records and saved recordings; live WebRTC audio is still an ephemeral peer-to-peer stream and is not itself written to the database unless a local microphone recording is explicitly saved. Basemap tiles are fetched from their map providers, not stored in Supabase. In the browser client, TomTom flow samples and raster traffic tiles are proxied through the authenticated Dispatch server, so the TomTom key is not placed in browser traffic-tile URLs. The Android WebView continues to request TomTom raster tiles directly because its app-assets origin cannot use the browser's same-origin tile proxy.

## Exercise the system

1. From Live operations, choose **Start route simulation**. Clocked-in demo units move around their assigned sites and the server stores their timestamped simulated fixes. Stop the simulation with the same control.
2. Open **Field** in a second tab, sign in with a provisioned user, clock in, and grant location permission to share device GPS. Offline fixes queue for retry.
3. For voice, start a private/group/all call from **Voice dispatch**, accept it in the Field view, and grant microphone permission. Both clients need direct network reachability; no STUN/TURN or SIP/PBX gateway is bundled. Microphone use outside localhost requires a secure context.
4. **Record local mic** captures a consented local microphone clip for playback; it does not silently record remote call audio.

## Diagnostics and bug reports

The local **Diagnostics** control records app-level function calls, UI actions, API outcomes, map errors, and server request status without capturing form values or secrets. Logs remain local; choose **Diagnostics → Download log** to create a JSON file you can attach to a bug report. See [DIAGNOSTICS.md](DIAGNOSTICS.md) for the full privacy notes and workflow.

## Android field APK

The native Android project is under `android/`. It connects to the Dispatch server; it does not dial cellular calls, send SMS, or access the phone call log. Location uses Android GPS while clocked in and queues fixes offline. The phone must reach the server over HTTPS when secure cookies are enabled. Configure the server URL in the Android app; do not use `localhost` on a physical phone. To refresh bundled web assets, run `./scripts/sync-android-assets.sh`. Build with JDK 17 and Android SDK Platform 35:

```sh
cd android
./gradlew :app:assembleDebug
```

No prebuilt APK is included. This workspace has no JDK or Android SDK, so the APK has not been compiled here.

## Maps, archive and workflows

- The map provides Street, Satellite and Topographic basemaps, 2D and pitched 3D perspectives, site/unit overlays, map-based geofence drawing, fit-to-units, geolocation, measurement and fullscreen. The 3D view is a pitched camera only; there is no terrain or building model layer. If external tiles fail, approximate local Sandton reference roads may be shown; they are not a substitute for real tiles.
- TomTom flow tiles remain full-color and require a configured key and provider attribution. Traffic history is sampled near configured work sites and stored in the Supabase state record; it is not a full historical street-network feed.
- Day Review uses the same replay time for recorded traffic and GPS fixes. It does not invent positions or readings. A date without GPS fixes will show no fabricated unit locations.
- The app includes roster/groups, shifts, alerts and SOS, dispatch messaging, WebRTC call history, recordings, relay/telemetry simulations, reports/CSV, audit history, and Supabase-backed backups/restore.
- Physical radios, telemetry outputs, SIP/PSTN, external email delivery, and hardware control require separate integrations. Current radio/relay/output controls are local simulations/configuration only.

## API notes

Operational API routes require an authenticated cookie. Important routes include `GET /api/state`, `POST /api/action`, `POST /api/ingest/location`, `POST /api/traffic`, `POST /api/traffic/sample` (server-side TomTom flow sampling), `GET /api/traffic/tiles/flow/relative/{z}/{x}/{y}.png` (short-lived cached TomTom tile proxy), `GET /api/export`, `POST /api/backup`, `GET /api/backups`, and `POST /api/restore`. Public auth routes are limited to `GET /api/auth/status`, `POST /api/auth/login`, and `POST /api/auth/logout`; the user-management endpoints require an administrator session.
