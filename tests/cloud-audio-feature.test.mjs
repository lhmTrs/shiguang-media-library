import test from "node:test";
import assert from "node:assert/strict";
import { CLOUD_AUDIO_FLAG, cloudAudioFeatureEnabled } from "../server/cloud-audio-feature.mjs";

test("cloud audio is available on a fresh installation without environment setup", () => {
  assert.equal(cloudAudioFeatureEnabled({}), true);
  assert.equal(cloudAudioFeatureEnabled({ [CLOUD_AUDIO_FLAG]: "1" }), true);
});

test("explicit disable and invalid overrides never enable cloud audio", () => {
  for (const value of ["0", "", "false", "true", " 1", "2", undefined]) {
    assert.equal(cloudAudioFeatureEnabled({ [CLOUD_AUDIO_FLAG]: value }), false);
  }
});
