# music-engine-preflight fixtures

Small synthetic text/JSON only. No real model, media, plugin venv or engine bytes.

- `evidence-license.txt`: hashed by the test-created approval `allowedEvidence`.
- `members-v0.json` / `members-v1.json`: valid `audio-release-members` declarations under 4 KiB.
- Pins, approval, materials, expectation and toolchain manifest are generated inside each
  RETAIN_ALL temporary root because their absolute paths and hashes are test-specific.
