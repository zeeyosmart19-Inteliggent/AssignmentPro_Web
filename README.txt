AssignmentPro — shared server edition (CREATED BY ZEEYO)

WHY THIS EDITION
  Teachers and students on DIFFERENT devices share one real database, so a student can join
  a teacher's class with the 6-8 digit code from any phone or computer.

RUN IT ON YOUR COMPUTER
  Install Node.js 20 or newer (https://nodejs.org), then:
    Mac/Linux: double-click start-mac-linux.command   (or:  node server.mjs)
    Windows:   double-click start-windows.bat
  Open http://localhost:8080 . Data is saved in the "data" folder next to server.mjs — back it up.

PUT IT ON THE WEB (assignmentpro.edu.smartmathpro.app)
  Use any host that runs Node or Docker and gives you a persistent disk (Fly.io, Railway, Render,
  a VPS...). Start command:  node server.mjs   Environment:  PORT (given by the host),
  DATA_DIR=<path of the persistent disk>.  A Dockerfile is included.
  Then add a CNAME:  name "assignmentpro.edu"  ->  the address your host gives you.
  (Static-only hosts such as Netlify Drop / GitHub Pages cannot run the shared database.)
  Students and teachers must use the https:// address: microphone recording and Google sign-in
  only work on https:// or http://localhost.

GOOGLE SIGN-IN (Error 400: origin_mismatch)
  Google Cloud Console -> APIs & Services -> Credentials -> your OAuth client ->
  Authorized JavaScript origins -> add EVERY address you use, exactly, no trailing slash:
     http://localhost:8080
     https://assignmentpro.edu.smartmathpro.app
  Your client ID is already in index.html (search OAUTH_CONFIG). No secret key is needed or stored.
  If the OAuth consent screen is in "Testing", add your Gmail under Test users.

CLASS CODES
  Every class gets a random unique 6-8 digit number. Teachers can copy it or regenerate it
  (students, assignments and grades are kept). Old letter-codes are converted automatically.

LIMITS (honest notes)
  The database is a JSON file written atomically: ideal for a school, a few hundred users.
  For thousands of simultaneous users move to PostgreSQL.

STATIC HOSTING (optional): the folder "static-hosting" holds CNAME / Caddyfile / _headers / vercel.json.
Copy them next to index.html only if you must use a static host (single-device mode, no shared classes).
The file index.html also works by itself: double-click it to open AssignmentPro on one device.

DEPLOY ON NETLIFY ONLY (shared database via Netlify DB / Postgres)
  Files: netlify.toml, netlify/functions/api.mjs (runs engine.mjs on Postgres), package.json (pg).
  1. Push this repo to GitHub and in Netlify choose "Add new site -> Import an existing project".
     (Drag-and-drop "Netlify Drop" does NOT deploy Functions - use the Git import or `netlify deploy --prod`.)
  2. In the site: Extensions/Database -> enable Netlify DB (or run `npx netlify db init`).
     This sets the NETLIFY_DATABASE_URL environment variable. Any Postgres URL in DATABASE_URL also works.
  3. Redeploy. Tables are created automatically on the first request.
  Every request takes a Postgres advisory lock, so simultaneous users never overwrite each other.
  Limits: uploads/recordings up to 5 MB (Netlify Functions request limit).

LEARN QURAN
  A separate section for teachers and students (sidebar: "Learn Quran"). Quran assignments,
  submissions and reading/memorization progress are stored apart from regular assignments and grades.
  Text files: quran/index.json + quran/s001.json ... s114.json (114 surahs, 6,236 ayahs), built from
  verified sources, never typed by hand or generated:
    Arabic   - Tanzil Uthmani text via AlQuran.cloud (edition quran-uthmani)
    English  - Saheeh International via AlQuran.cloud (en.sahih)
    Uzbek    - Muhammad Sodiq Muhammad Yusuf (Latin) via Quran.com (translation 55)
    Surah names / Makki-Madani - Quran.com chapters API (cross-checked with AlQuran.cloud)
  The Basmalah is shown as a header (it is ayah 1 only in Al-Fatihah; At-Tawbah has none).
  The quran/ folder must be deployed next to index.html (netlify.toml copies it into dist/).
