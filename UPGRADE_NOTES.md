# ConnectHub 3.0 upgrade notes

This package is based on the supplied ConnectHub 2.0 ZIP. The original React app, Express API, Socket.IO signalling, WebRTC calling, SQLite/sql.js persistence and delete-message workflows were retained.

## Preserved data and functionality

- Existing `users`, `conversations`, `participants`, `messages` and `hidden_messages` tables are not dropped.
- New schema fields are added with guarded `ALTER TABLE` migrations.
- Existing accounts and message deletion endpoints remain in place.
- The SQLite file remains at `server/data/connecthub.sqlite` unless `DATA_DIR` is configured.

## New components

- `client/public/manifest.webmanifest`
- `client/public/sw.js`
- `client/public/offline.html`
- `client/public/icons/*` (application icons and iOS startup images)
- QR pairing and device management routes in `server/server.js`
- Push subscription routes and VAPID configuration
- Reply, unread-count, delivery receipt and group administration support

## Validation performed in the build environment

- `node --check server/server.js` passed.
- SQLite schema was extracted from the server source and executed in an in-memory SQLite database; the resulting schema includes the original messaging tables and new pairing/device/push tables.
- Additive migration statements were exercised against both a fresh schema and a simulated original 2.x schema (duplicate-column cases are guarded by the server migration `try/catch`).
- Root/client/server package JSON and PWA manifest JSON parsed successfully; Render YAML parsed successfully.

## Validation not performed

The npm registry was not reachable within the available build window, so dependencies could not be installed and the Vite/React production build could not be run here. The complete browser-to-browser chat, QR camera scan, push delivery, and cross-network WebRTC/TURN flows still require runtime testing after `npm run install:all` on a machine with npm registry access. Do not treat this ZIP as a claim that external TURN connectivity or push-service delivery has been verified.


## Public internet deployment update

- Render Blueprint no longer hardcodes `https://connecthub.onrender.com`; this avoids a mismatch if the generated service hostname differs.
- The backend uses Render's automatically supplied `RENDER_EXTERNAL_URL` as the public origin for CORS and as the QR pairing URL fallback.
- `CLIENT_URL` and `PUBLIC_APP_URL` remain optional overrides for a custom domain.
- The app is intended to run as one public HTTPS web service with persistent storage. Localhost is not the address to share with remote devices.
