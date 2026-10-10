# FriendZone — Campus Collaboration

A beginner-friendly BCA first-semester project with a campus directory and Google-authenticated collaboration rooms.

## Files in this project

- `index.html`, `styles.css`, `app.js` — a responsive campus directory and authenticated project-room interface. Student/demo data stays in browser storage.
- `server.js` — the FriendZone API, Google ID-token verification, signed HttpOnly login sessions, study rooms, shared idea boards, and room chat.
- `friendzone.c` — the C console application for demonstrating structures, arrays, functions, validation, and file handling.

The website is a front-end demo and is **not connected** to the C program. C does not directly draw a web page; a production website normally uses HTML/CSS/JavaScript in the browser and a server or API behind it. Keeping the front-end demo and C coursework program separate makes both easy to run and explain.

## Run the website

Install Node.js 20 or newer. In this folder, create your local environment file:

```powershell
Copy-Item .env.example .env
```

On Windows PowerShell, create a strong session-signing key and put it in `.env`:

```powershell
$secret = (node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))").Trim()
$lines = Get-Content .env | Where-Object { $_ -notmatch '^SESSION_SECRET=' }
[System.IO.File]::WriteAllLines((Join-Path $PWD '.env'), [string[]]($lines + "SESSION_SECRET=$secret"))
```

Then set `GOOGLE_CLIENT_ID` in `.env` to your Google OAuth **Web application client ID** and start the app:

```sh
npm start
```

Open `http://localhost:8000`. Do not open `index.html` directly or use a separate static server; the page and API must share the same origin.

### Configure Google

1. In Google Cloud Console, create/select a project and configure its OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**.
3. Add `http://localhost:8000` under **Authorized JavaScript origins**.
4. Set `GOOGLE_CLIENT_ID` in `.env` to that client ID and restart `npm start`.
5. In production, add your HTTPS site origin to Google’s authorized origins and set `APP_ORIGIN` to that exact origin.

The browser uses Google Identity Services to obtain an ID token and sends it to `POST /api/auth/google`. The API verifies the token's RSA signature against Google's published signing keys and checks its issuer, audience, expiry, and verified email. It then issues a signed, HttpOnly, SameSite=Lax session cookie. `GET /api/auth/me` reads the session and `POST /api/auth/logout` clears it. The OAuth client ID is public; no client secret is needed for this ID-token flow. Never put a client secret in browser code.

**Google setup is optional.** Basic Google sign-in uses the standard `openid`, `email`, and `profile` identity scopes; do not enable paid Google APIs or attach a billing account just to try this login. To use the sample preview without Google setup, choose **Skip setup and explore with a sample profile** on the sign-in screen. The demo profile is sample-only: it cannot send friend requests or use collaboration rooms. After Google sign-in, complete the campus profile with a department, subjects, and skills. The account is then automatically listed in **Campus people**; there is no manual add-student action. Completed profile details are visible to signed-in campus members; Google photos remain private unless explicitly shared in profile settings. Friend requests must be accepted before two members can message privately. Google members can join **Campus Commons** or create password-protected project rooms. A room host can invite accepted friends directly, without requiring them to enter the room password. Members must join a room before reading its board or chat.

Campus profiles, friend requests, room memberships, salted password hashes, shared board notes, chat messages, Google account identifiers, and photo-visibility settings are stored in `.friendzone-chat.json` beside the server. Keep this file private and back it up with care; chat and board content is unencrypted. Room passwords are never returned by the API and are stored as scrypt hashes. The built-in JSON store is intended for a small, single-server classroom demo, not production or concurrent multi-server hosting. Deploying the app to one shared HTTPS host is required for users on different devices to collaborate; `localhost` is only reachable from the machine running it.

If you want real Google sign-in, the Google client ID must be created in your own Google account; FriendZone cannot create or access credentials on your behalf:

1. Open the [Google Auth Platform clients page](https://console.cloud.google.com/auth/clients) and sign in.
2. Create/select a project if asked. Set up the consent screen/branding if prompted; for classroom testing, choose **External** and add your Google account as a test user if Google asks.
3. Create a client with type **Web application**.
4. Under **Authorized JavaScript origins**, add exactly `http://localhost:8000`. Do not add a redirect URL for this project.
5. Copy the client ID (it ends with `.apps.googleusercontent.com`) and paste it after `GOOGLE_CLIENT_ID=` in this folder's `.env` file. Do not share or paste a client secret.
6. Save `.env`, restart the app with `npm start`, reload FriendZone, then open the profile menu and sign in with Google.

The API uses only Node.js built-in modules, so no `npm install` is needed. A demo profile is only a UI preview saved locally and does not authenticate or authorize any API request. Do not use real student records or production-sensitive conversations with this classroom demo. Production deployments need a proper database, moderation and reporting controls, HTTPS, private environment configuration, and `APP_ORIGIN` set to the exact public HTTPS origin.

## Build and run the C program

With GCC installed, open a terminal in this folder:

```sh
gcc -std=c11 -Wall -Wextra -pedantic friendzone.c -o friendzone
./friendzone
```

On Windows, run the generated program as `.\friendzone.exe`. The program saves records to `friendzone_data.txt` in its current working directory. Keep names and departments free of the `|` character because that character separates fields in the simple text data file.

## Concepts to explain in a viva

- **Structure:** `Student` groups a student's ID, name, department, year, and hometown.
- **Array:** arrays hold a fixed number of students and friendship pairs.
- **Functions:** each menu action is organized into its own function.
- **Searching:** `findStudentIndex` looks up a student by their ID.
- **File handling:** `saveData` and `loadData` preserve records between program runs.
- **Validation:** IDs must be unique and positive; a student cannot be connected to themselves or to the same friend twice.

## Scope and limitations

This is a small local classroom project, not a production social network. The C version uses fixed-size arrays and a plain-text file; the web demo keeps campus profiles and collaboration data in a local JSON file on its server. Use fictional student data and avoid sensitive conversations.
