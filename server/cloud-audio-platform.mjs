// Fixed server capability, never supplied by HTTP, feature flags, or saved configuration.
const platform = process.platform;
export const CLOUD_AUDIO_PLATFORM_UNSUPPORTED = 'WINDOWS_CLOUD_AUDIO_UNSUPPORTED';
const capability = Object.freeze({ platform, supported: platform !== 'win32', code: platform === 'win32' ? CLOUD_AUDIO_PLATFORM_UNSUPPORTED : null });
export function cloudAudioPlatformCapability() { return capability; }
export function requireCloudAudioPlatform() {
  if (!capability.supported) throw Object.assign(new Error(CLOUD_AUDIO_PLATFORM_UNSUPPORTED), { code: CLOUD_AUDIO_PLATFORM_UNSUPPORTED, status: 503 });
}
