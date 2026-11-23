AssignmentPro — deploy to https://assignmentpro.edu.smartmathpro.app   (CREATED BY ZEEYO)

WHAT'S HERE
  index.html   the app (Apple return URL already set to https://assignmentpro.edu.smartmathpro.app/)
  CNAME        for GitHub Pages
  _headers     for Netlify / Cloudflare Pages (microphone + Google pop-up headers)
  vercel.json  same headers for Vercel
  Caddyfile    for your own server (Caddy gets the https certificate automatically)

STEP 1 — HOST THE FOLDER (pick one)
  Netlify:      app.netlify.com/drop -> drag this folder -> Domain management -> Add domain assignmentpro.edu.smartmathpro.app
  Cloudflare Pages / Vercel / GitHub Pages: upload the folder, then add the custom domain assignmentpro.edu.smartmathpro.app
  Own server:   copy index.html to /var/www/assignmentpro and use the Caddyfile

STEP 2 — DNS (where smartmathpro.app's DNS is managed)
  Add a CNAME record:
     Name/Host:  assignmentpro.edu        (the full name is assignmentpro.edu.smartmathpro.app)
     Value:      the address your host gives you (e.g. yoursite.netlify.app)
  Wait for DNS + the https certificate (a few minutes up to an hour).

STEP 3 — GOOGLE SIGN-IN
  Google Cloud Console -> Credentials -> your OAuth client ->
  Authorized JavaScript origins -> add:   https://assignmentpro.edu.smartmathpro.app
  (no trailing slash). Then open https://assignmentpro.edu.smartmathpro.app, click Google, paste the Client ID, Save.
  To make it permanent, put it in index.html: search OAUTH_CONFIG -> google: { clientId: '...' }
  Facebook / Apple / Telegram: register https://assignmentpro.edu.smartmathpro.app in each provider's console too.

NOTE
  Accounts and data are stored per web address. Data made on localhost:8080 will not
  appear on https://assignmentpro.edu.smartmathpro.app — everyone creates accounts again there.

NOTE: this static package runs in SINGLE-DEVICE mode (each browser keeps its own data).
For classes shared across devices use AssignmentPro-server.zip on a Node host.
