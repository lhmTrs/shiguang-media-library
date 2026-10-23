#!/bin/sh
# Read-only local evidence collector for #0059. Does not touch the real data dir,
# the cloud project, the production server, or any credential.
set -eu
cd "$(dirname "$0")/../../.."

echo "== collected_at =="
date '+%F %T %z'
echo

echo "== node_syntax =="
for f in server/audio-engine.mjs server/audio-analysis.mjs server/index.mjs; do
  node --check "$f" && echo "OK $f"
done
echo

echo "== file_sha256 =="
shasum -a 256 server/audio-engine.mjs server/audio-analysis.mjs server/audio-engine-ca.pem collab/results/MAILBOX-0059/diff-audio.patch
echo

echo "== audio_routes =="
grep -n 'audio-engine\|analyze-audio\|assets/:id/audio' server/index.mjs
echo

echo "== asset_audio_schema =="
sed -n '/CREATE TABLE IF NOT EXISTS asset_audio/,/`;/p' server/audio-analysis.mjs
echo

echo "== safety_markers =="
grep -n 'rejectUnauthorized\|curl -k\|insecure\|freeSocketTimeout' server/audio-engine.mjs server/audio-analysis.mjs || true
grep -n 'cloud\|sync\|upload' server/audio-engine.mjs server/audio-analysis.mjs || true
grep -n 'tar\|spawn\|timeout\|maxSockets\|content-length' server/audio-engine.mjs server/audio-analysis.mjs || true
echo

echo "== ca_certificate =="
openssl x509 -in server/audio-engine-ca.pem -noout -subject -issuer -dates -fingerprint -sha256 -ext subjectAltName
echo

echo "== packaging_ca =="
git check-ignore -v server/audio-engine-ca.pem || true
grep -n '"server"' scripts/package.mjs | head -2
echo

echo "== git_state =="
git status --short -- server/index.mjs server/audio-engine.mjs server/audio-analysis.mjs server/audio-engine-ca.pem
