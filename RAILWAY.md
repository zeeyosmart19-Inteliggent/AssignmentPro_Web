# Deploy AssignmentPro on Railway

The app is one Node server (`server.mjs`) that serves `index.html` and the `/api/*` routes.
On Railway it stores everything in a Postgres database (via `DATABASE_URL`).

## Steps

1. **Push the repo to GitHub** (commit the changes from this migration first).
2. **Create the project.** In Railway, choose *New Project -> Deploy from GitHub repo* and pick this repo.
   Railway reads `railway.json` and builds with the `Dockerfile`.
3. **Add the database.** In the project, choose *New -> Database -> Add PostgreSQL*.
4. **Connect the two.** Open your app service -> *Variables* -> *New Variable* -> *Add Reference*:
   - Name: `DATABASE_URL`
   - Value: `${{Postgres.DATABASE_URL}}`
   (If your database service has a different name, use that name instead of `Postgres`.)
   Railway redeploys automatically. Tables are created on the first request.
5. **Get a public URL.** App service -> *Settings -> Networking -> Generate Domain*.
   Open it and check `https://<your-domain>/api/health/db`. It should return `{"ok":true}`.
6. **Move your data (optional).** The Netlify database is separate from this new one. If you have real
   classes to keep, export from the old database and import into the new one, for example:
   `pg_dump --schema=assignmentpro --no-owner "$OLD_URL" | psql "$NEW_PUBLIC_URL"`
   (`NEW_PUBLIC_URL` is `DATABASE_PUBLIC_URL` from the Railway Postgres Variables tab.)
   Do this before pointing students at the new site. If you start fresh, skip it.
7. **Custom domain.** App service -> *Settings -> Networking -> Custom Domain* -> enter
   `assignmentpro.edu.smartmathpro.app`. Railway shows a CNAME target. At your DNS provider, change the
   existing record for that name from Netlify to the Railway target. HTTPS is issued automatically.
8. **Google sign-in.** In Google Cloud Console -> Credentials -> your OAuth client -> *Authorized JavaScript
   origins*, add the Railway domain (and keep the custom domain). No trailing slash.
9. **Clean up Netlify.** After checking the new site, delete the Netlify site and its database.

## Notes

- Uploads and recordings are stored in Postgres; the limit is 32 MB per file.
- Railway sets `PORT` for you. Do not set it yourself.
- No Postgres? If `DATABASE_URL` is not set, the server falls back to JSON files in `DATA_DIR`. On Railway
  that needs a Volume mounted at `/data`, but Postgres is the better choice.
- Local run: `node server.mjs` (file mode) or `DATABASE_URL=postgres://... node server.mjs` (Postgres mode).
- Troubleshooting: if the site loads but sign-in fails, open `/api/health/db`. The error says what is wrong.
