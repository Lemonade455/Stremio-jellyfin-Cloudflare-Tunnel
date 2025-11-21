# Stremio Jellyfin Addon
Direct Stream Addon för Jellyfin → Stremio (Full Metadata + Episode Images)
Denna addon erbjuder:
- Korrekt seriestruktur (Säsonger → Avsnitt)
- Avsnittsbilder
- Avsnittsbeskrivningar
- Full metadata för filmer + TMDB fallback
- Direktströmmar
- Multiversionskompatibel Jellyfin-login
- Build-taggar i alla filer
---
## Installation via Docker
1. Klona repot:
git clone https://github.com/Lemonade455/Stremio-jellyfin-Cloudflare-Tunnel.git
2. Fyll i .env:
JELLYFIN_SERVER=
JELLYFIN_USER=
JELLYFIN_PASSWORD=
PUBLIC_URL=
3. Starta:
docker compose up -d
---
## Lägg till i Stremio
https://stremio-addon.dindomän/manifest.json
---
## Struktur
addon.js
manifest.json
docker-compose.yml
package.json
Dockerfile
.env
---
## Jellyfin Login
Addonen skickar flera kompatibla fält:
Username, Pw, Password, username, password
---
## Metadata & Episoder
Episodes hämtas via:
GET /Items?ParentId={id}&IncludeItemTypes;=Episode&Recursive;=true
---
## Build Tagging
Alla filer har:
BUILD: 2025-02-15_01
---
## Felsökning
HTTP 400 → kontrollera .env
No metadata → rensa cache i Stremio
