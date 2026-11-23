AssignmentPro — run locally (CREATED BY ZEEYO)

START
  Mac/Linux: double-click start-mac-linux.command
             (if macOS blocks it: open Terminal, type  cd  then drag this folder in, press Enter,
              then run:  python3 serve.py )
  Windows:   double-click start-windows.bat

Then open  http://localhost:8080  (it opens automatically). Keep the window open.

ALWAYS use http://localhost:8080 — accounts are saved per address, so a different
address (or port) will look empty.

GOOGLE SIGN-IN
  1. Google Cloud Console -> Credentials -> your OAuth client ->
     Authorized JavaScript origins -> add:  http://localhost:8080
  2. OAuth consent screen: if the app is in "Testing", add your Gmail under Test users.
  3. Put the client ID into OAUTH_CONFIG in index.html (search for OAUTH_CONFIG), save, refresh.
