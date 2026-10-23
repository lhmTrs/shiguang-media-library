#!/bin/sh
# READ-ONLY audit for the 443 / nginx download site (reply #0059).
# This script must NOT be run without authorization. It makes no changes:
# no writes, no reload/restart, no chmod/chown, no firewall/security-group calls,
# and it never prints private-key file contents.
#
# Run as root (needed for process names on listening sockets); review output
# locally before sharing. nginx -T prints certificate/key *paths*, not key bytes.
set -u

section() { printf '\n===== %s =====\n' "$1"; }

section "host/time"
date '+%F %T %z'
hostname

section "nginx version"
nginx -v 2>&1 || true
dpkg-query -W -f='${Package} ${Version}\n' nginx nginx-common 2>/dev/null || true

section "service state"
systemctl is-enabled nginx 2>&1 || true
systemctl is-active nginx 2>&1 || true
systemctl show nginx -p ActiveState -p SubState -p ExecMainPID -p FragmentPath 2>&1 || true

section "listeners 443/8443/8444/80"
ss -ltnp 2>/dev/null | grep -E ':(80|443|8443|8444)[[:space:]]' || true

section "nginx full config (paths only for cert/key; no file contents)"
nginx -T 2>&1 || true

section "config files"
find /etc/nginx -maxdepth 3 -type f -name '*.conf' -printf '%m %u:%g %p\n' 2>/dev/null | sort || true
ls -la /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true

section "download directory permissions chain"
for p in /srv /srv/shiguang /srv/shiguang/downloads; do
  [ -e "$p" ] && stat -c '%A %a %U:%G %n' "$p"
done
namei -l /srv/shiguang 2>/dev/null || true
namei -l /srv/shiguang/downloads 2>/dev/null || true
getfacl -p /srv /srv/shiguang /srv/shiguang/downloads 2>/dev/null || true

section "download directory entries (no file contents)"
find /srv/shiguang/downloads -maxdepth 2 -printf '%y %m %u:%g %s %p -> %l\n' 2>/dev/null | sort || true
readlink -f /srv/shiguang/downloads 2>/dev/null || true

section "certificates referenced by nginx (public certs only)"
# Extract certificate paths from nginx -T; ignore ssl_certificate_key entirely.
nginx -T 2>/dev/null | awk '/^[[:space:]]*ssl_certificate[[:space:]]/ {gsub(/;$/, "", $2); print $2}' | sort -u | while read -r cert; do
  [ -r "$cert" ] || { echo "UNREADABLE $cert"; continue; }
  echo "--- $cert"
  openssl x509 -in "$cert" -noout -subject -issuer -dates -fingerprint -sha256 -ext subjectAltName 2>&1 || true
done

section "recent nginx journal (read-only)"
journalctl -u nginx -n 30 --no-pager 2>/dev/null || true

section "done"
echo "No changes were made by this script."
