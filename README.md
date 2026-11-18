# ConnectHub 3.0 — Full-stack messaging + PWA + secure device pairing

ConnectHub is an upgrade of the supplied ConnectHub 2.0 project. It retains the React/Vite client, Express API, Socket.IO, WebRTC and SQLite database rather than replacing the original app. Existing user, conversation and message tables are extended with additive migrations.

## Technology

- Frontend: React 19, Vite, Axios, Socket.IO Client, Lucide React, `qrcode.react`
- Backend: Node.js 20+, Express, Socket.IO, JWT, bcryptjs, Helmet, express-rate-limit
- Data: SQLite via sql.js; uploaded files stored on disk
- Calling: WebRTC with STUN and optional TURN REST credentials
- PWA: Web App Manifest, service worker, offline fallback, install icons, browser notifications and optional Web Push

## Existing features retained

- Registration, sign-in, profile editing and profile images
- User search and direct conversations
- Group creation
- Persistent chat history and Socket.IO real-time messaging
- Message editing
- Delete for me and delete for everyone; clear chat for me/everyone
- Image and document sharing
- Typing and online presence
- Read receipts and one-to-one audio/video call signalling

## ConnectHub 3.0 additions

- Installable PWA shell, standalone display, offline fallback and mobile safe-area styling
- Secure QR pairing: 256-bit random token, SHA-256 hash stored server-side, three-minute expiry, one-time use, mobile request review and desktop approval
- Per-device records, last-active timestamps and revocation
- Multiple simultaneous sockets per account (desktop and mobile)
- Reply-to-message, in-conversation message search, unread counts and delivered receipts
- Browser notification permission flow and optional Web Push for new messages
- Server-issued one-hour TURN REST credentials when a TURN shared secret is configured
- Camera switching on supported mobile devices

## Run locally (Windows PowerShell / macOS / Linux)

Requirements: Node.js 20 or newer and npm.

1. Extract the ZIP and open a terminal in the `ConnectHub-3.0` folder.
2. Install dependencies:

   ```bash
   npm run install:all
   ```

3. Copy `server/.env.example` to `server/.env`. Set a private random `JWT_SECRET` of at least 32 characters. The development fallback is intentionally not suitable for production.
4. Start both applications:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`.

The Vite development server proxies `/api`, `/uploads` and `/socket.io` to the Express server on port 5000. This local URL is only for development; use the public HTTPS cloud URL for devices on separate networks.

## Access ConnectHub from anywhere (mobile data, Wi-Fi, desktop and iPhone)

**Important:** `localhost` is only the computer on which the app is running. It is not an internet address. To let devices on different networks use the same accounts and messages, deploy the frontend and backend to one public HTTPS cloud URL. This project is configured for a single-origin Render deployment. Once deployed, every device opens the same URL using its own internet connection; the phone and desktop do not need to share Wi-Fi and your personal computer does not need to stay on.

### Deploy using the included Render Blueprint

1. Create a GitHub repository and upload the extracted `ConnectHub-3.0` folder contents (keep `render.yaml` at the repository root).
2. Create/sign in to a Render account and connect that GitHub repository.
3. Choose **New + → Blueprint** and select the repository. Render reads `render.yaml`, builds the React app and starts the Express + Socket.IO server.
4. The Blueprint creates a persistent disk at `/var/data`. Keep this disk attached: it stores the SQLite database and uploaded files. The configured `starter` web-service plan and persistent disk may incur hosting charges; a free ephemeral host is not suitable for preserving user accounts, chat history and uploads across restarts.
5. In the Render service environment, confirm `NODE_ENV=production`, `DATA_DIR=/var/data`, `UPLOAD_DIR=/var/data/uploads`, and set a private `JWT_SECRET` of at least 32 random characters. Render supplies `RENDER_EXTERNAL_URL` automatically; the app uses it for same-origin CORS and QR links.
6. Wait for deployment to finish, then open the public `https://<your-service>.onrender.com` URL. Register one account on desktop and sign in with the same account on a phone using mobile data. The QR pairing flow also uses this public HTTPS address.
7. If you attach a custom domain, set `CLIENT_URL` to the exact custom HTTPS origin (no trailing slash). For multiple frontends, separate origins with commas. Set `PUBLIC_APP_URL` to the canonical public HTTPS URL if you want QR codes to always use your custom domain.

### How devices share data

All clients connect to the same deployed Express API, Socket.IO server, SQLite database and upload storage. Accounts, contacts, groups and chat history are therefore shared. A user does not host a second server on their phone. The phone only needs an internet connection and a supported browser/PWA.

### Production hosting constraints

The current SQLite/sql.js persistence model and local upload directory are for **one server instance**. Do not enable multiple server instances or horizontal autoscaling: separate instances would not share the in-memory SQLite state or local uploads. For larger scale, migrate to a managed shared database (for example PostgreSQL) and object storage before scaling. Keep the persistent disk and take backups.

## Secure QR pairing workflow

1. Sign in on the desktop.
2. Choose **Connect mobile** in the sidebar.
3. Scan the QR code using the phone camera. The QR contains a temporary pairing secret only; it never contains a password or an existing JWT.
4. The phone opens `PUBLIC_APP_URL/?pair=...`. Review the request and tap **Review and request pairing**.
5. Approve the device on the desktop.
6. The phone exchanges the approved one-time secret for a separate 30-day device JWT.
7. Manage or revoke linked devices using **Connected devices**.

Pairing requests expire after three minutes. The database stores a SHA-256 hash of the QR secret; the secret is invalidated after successful exchange. Use HTTPS in production. Localhost pairing on one computer is not a valid phone-to-desktop test; use a reachable HTTPS deployment or configure an appropriate LAN URL for development.

## PWA installation

- Android / desktop Chromium: open the HTTPS app and use the browser's Install app option (or the in-app install action when offered).
- iPhone / iPad: open the HTTPS app in Safari, tap Share, then **Add to Home Screen**.
- The service worker caches the app shell and shows `offline.html` when navigation cannot reach the server. Live chat, sign-in, uploads, push and calls still require connectivity.

## Web Push setup (optional)

Generate VAPID keys from the server directory:

```bash
npx web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in the server environment. Restart the server and choose **Enable notifications** in ConnectHub. Keep the private key secret. Push delivery depends on browser support, user permission and the push service. The included push flow sends new-message notifications; it is not a guaranteed background calling service.

## WebRTC / TURN setup

STUN is enabled by default. For more reliable connections across restrictive NATs and mobile networks, deploy a TURN service such as coturn and set:

```env
TURN_URL=turn:turn.example.com:3478
TURN_SHARED_SECRET=your-coturn-static-auth-secret
```

Configure coturn with the matching REST/shared-secret authentication secret. The backend generates time-limited TURN credentials (one hour) and the frontend fetches ICE configuration from `/api/config`. Never put the TURN shared secret in a `VITE_` variable or frontend bundle.

**Important:** Calls have not been verified across different networks in this build environment. STUN-only connectivity is not guaranteed. Do not claim cross-network calling works until you test with two devices on separate networks and a working TURN relay.

## Security notes and production checklist

- Passwords are hashed with bcryptjs (12 rounds); new registrations require at least 8 characters.
- JWT secrets are required in production; JWT lifetime is one day for normal sign-ins and 30 days for device-pairing sessions. Device JWTs are checked against the revocation table on each protected API request.
- Helmet, CORS allow-listing, authentication rate limits, message/pairing rate limits and request size limits are enabled.
- Uploads have a 15 MB limit and an allow-list of supported MIME types and extensions. MIME checks are not a substitute for malware scanning; add antivirus scanning and content sniffing before public production use.
- Existing browser authentication still uses a bearer JWT managed by the client. Protect against XSS: keep dependencies updated, avoid injecting untrusted HTML, enforce HTTPS and consider moving production authentication to secure HttpOnly cookies with CSRF protection before handling sensitive workloads.
- This project does not provide end-to-end encryption. Server administrators with database and upload access can access stored data.
- Use backups for the SQLite database and uploads.

## Known scope / items requiring deployment validation

- Calls are one-to-one. Group calls, call recording and guaranteed background call alerts are not included.
- TURN requires a separately operated and configured TURN server; the project does not host one.
- Push notifications require VAPID keys and browser permission. iOS PWA push support depends on supported iOS versions and installation context.
- Group creation, group rename and admin-controlled add/remove member actions are included; admin role transfer and member roles are not implemented.
- The current storage model is single-instance SQLite/local disk, not a multi-region or horizontally scaled service.
- The app shell can open offline, but messages are not queued for offline sending and live conversation data is not available without the backend.

## Test checklist

Use two separate accounts and at least two devices/browsers:

- Register, sign in and verify existing account access after upgrade.
- Start a direct chat; send, edit, reply to and delete messages (both deletion scopes).
- Create a group and send messages/files.
- Verify delivered/read states, typing, presence and unread counts.
- Upload permitted images/documents and reject oversized or unsupported files.
- Pair a phone by QR, approve on desktop, verify same account conversations, then revoke the device and confirm its next protected API request is rejected.
- Install the PWA on Android/desktop and add it to the iOS Home Screen; check the offline fallback.
- Configure VAPID and test push on supported browsers.
- Test audio/video on separate Wi-Fi/mobile networks with TURN configured; inspect connection state and permissions.

## Project structure

```text
ConnectHub-3.0/
├── client/
│   ├── public/
│   │   ├── icons/
│   │   ├── manifest.webmanifest
│   │   ├── offline.html
│   │   └── sw.js
│   └── src/
│       ├── main.jsx
│       └── style.css
├── server/
│   ├── data/
│   ├── uploads/
│   ├── .env.example
│   ├── package.json
│   └── server.js
├── package.json
├── render.yaml
└── README.md
```

**Project:** ConnectHub 3.0  
**Upgrade base:** User-provided ConnectHub 2.0 ZIP  
