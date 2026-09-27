ja2-web - prebuilt engine (bring-your-own JA2 Gold data).

RUN IT (pick one):
  A) python3 server.py       -> http://localhost:8795   (needs only Python 3)
  B) docker compose up       -> http://localhost:8080   (needs Docker)
  C) docker run -p 8080:80 ghcr.io/virtastic/ja2-web:latest

Then open the URL in desktop Chrome/Chromium and point the launcher at your own
JA2 "Data" folder. No game data is included.

To serve the data yourself (no folder-picking for players), drop ja2-gamedata.js
+ ja2-gamedata.data next to index.html - see SELF_HOSTING.md in the repo.

Source & docs: https://github.com/Virtastic/ja2-web   -   GPL-3.0-or-later
