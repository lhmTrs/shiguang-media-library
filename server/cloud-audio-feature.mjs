export const CLOUD_AUDIO_FLAG = "MEDIA_CLOUD_AUDIO_ENABLED";

export function cloudAudioFeatureEnabled(env = process.env) {
  if (!Object.hasOwn(env, CLOUD_AUDIO_FLAG)) return true;
  return env[CLOUD_AUDIO_FLAG] === "1";
}
