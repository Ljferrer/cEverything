#!/usr/bin/env sh
# Generate a self-signed certificate for LAN HTTPS (Quest accepts it with a warning; Safari is stricter).
# Usage: scripts/make-cert.sh [extra-ip-or-host ...]   → certs/server.key + certs/server.crt
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found. Install it (apt install openssl / brew install openssl) or copy certs/server.{key,crt} from another machine." >&2
  exit 1
fi
HOSTS="localhost 127.0.0.1"
# LAN IPv4 addresses (Linux: hostname -I / ip; macOS: ifconfig)
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  HOSTS="$HOSTS $(hostname -I 2>/dev/null)"
elif command -v ifconfig >/dev/null 2>&1; then
  HOSTS="$HOSTS $(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}')"
fi
HOSTS="$HOSTS $*"
SAN=""
for h in $HOSTS; do
  case "$h" in
    *.*.*.*) entry="IP:$h" ;;
    *) entry="DNS:$h" ;;
  esac
  case ",$SAN," in *",$entry,"*) ;; *) SAN="${SAN:+$SAN,}$entry" ;; esac
done
echo "SAN: $SAN"
set -x
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=cEverything" -addext "subjectAltName=$SAN"
set +x
echo "wrote certs/server.key and certs/server.crt — start with: node server/index.js --tls"
