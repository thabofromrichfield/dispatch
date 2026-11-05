# Dispatch diagnostics

Dispatch now includes a local diagnostic recorder so you can reproduce a problem, download a trace, and attach it to a report.

## Use it

1. Pull the latest `arena/0039368f-dispatch` branch and restart the Node app.
2. Open Dispatch and use the **Diagnostics** button at the bottom-right. Recording is on by default, including on the sign-in screen.
3. Walk through the actions that lead to the problem. The recorder traces app-level global function calls, UI activations and safe keyboard actions, form submissions, API requests and results, map/tile failures, browser errors, and server API routes/actions.
4. Open **Diagnostics → Download log** and attach the downloaded `dispatch-diagnostics-….json` file to your report. When an authenticated session is available, the download includes the server's recent diagnostic events too.

Use **Pause recording** to stop capture temporarily. **Clear browser log** clears only that browser's saved trace. The browser ring buffer is capped at 12,000 events; the server log is capped and rotated under `data/diagnostics.ndjson`.

## Privacy and limits

- Diagnostics are stored locally in the browser and in the app's ignored `data/` directory. They are **not automatically uploaded** to Supabase or sent to a third party.
- Form values, typed characters, passwords, API keys, cookies, request bodies, and query strings are not recorded. Field names/types and safe control identifiers are included to identify which UI was used.
- The download includes browser/runtime details (browser user agent, language, viewport, and current path) to help reproduce layout and compatibility issues.
- App-level global functions are traced with call/return/error timing. This does not trace private closure internals or every function inside third-party libraries; UI, API, map, and server events around those operations are recorded instead.
- Do not attach logs publicly if they may contain operational context you consider sensitive. Review the JSON before sharing if needed.

The browser recorder is `public/diagnostics.js`; server-side logging and its export are implemented in `server-diagnostics.js` and `server.js`.
