import type { Capability } from '../capabilities.ts';

// Managed bloat list for the Android guest.
// Package names and grouping transcribed from kdbhalala/avdslim
// (internal/bloat/packages.go, MIT; see NOTICE). Descriptions are our own
// wording. Nothing here was validated against a real image: the debloat (T2)
// cross-checks with `pm list packages` before disabling.

export type BloatLevel = 'standard' | 'aggressive';

export type BloatCategory = Readonly<{
  id: string;
  level: BloatLevel;
  description: string;
  packages: readonly string[];
}>;

// Packages we never disable, even if they show up in some source list.
// bluetooth: system_server crash-loops on Android 16+ without it.
// chrome: expo-web-browser and OAuth depend on it.
// Gboard moved out of here: it is only in the aggressive list (see GBOARD).
export const NEVER_DISABLE: readonly string[] = Object.freeze([
  'com.google.android.bluetooth',
  'com.android.chrome',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.webview',
  'com.android.systemui',
  'com.android.settings',
  'com.android.providers.settings',
  'com.android.inputmethod.latin',
  'com.android.shell',
]);

export const PLAY_STORE = 'com.android.vending';
// google_apis on-screen keyboard (measured 2026-11-17: 81 MB of PSS in the guest).
// Without it text still arrives via adb/argent input, but layouts that move
// around the keyboard cannot be tested; the keyboard capability keeps it.
export const GBOARD = 'com.google.android.inputmethod.latin';

// Kept by capability: when the capability is present the package leaves the plan.
export const KEPT_BY_CAPABILITY: Readonly<Partial<Record<Capability, readonly string[]>>> = Object.freeze({
  camera: Object.freeze(['com.android.camera2', 'com.android.cameraextensions']),
  // Apps using maps/geocoding often open Maps (geo: intents, navigation).
  location: Object.freeze(['com.google.android.apps.maps']),
  store: Object.freeze([PLAY_STORE]),
  keyboard: Object.freeze([GBOARD]),
});

function category(id: string, level: BloatLevel, description: string, packages: string[]): BloatCategory {
  return Object.freeze({ id, level, description, packages: Object.freeze(packages) });
}

export const BLOAT_CATEGORIES: readonly BloatCategory[] = Object.freeze([
  category('assistant-search', 'standard', 'Google Assistant, search and background AI services', [
    'com.google.android.googlequicksearchbox',
    'com.google.android.as',
    'com.google.android.as.oss',
  ]),
  category('bluetooth-peripherals', 'standard', 'Bluetooth MIDI service (the Bluetooth APK itself is never included)', [
    'com.android.bluetoothmidiservice',
  ]),
  category('ads-measurement', 'standard', 'Privacy Sandbox and ad measurement', [
    'com.google.android.adservices.api',
    'com.google.mainline.adservices',
  ]),
  category('wellbeing-intelligence', 'standard', 'Digital Wellbeing, smart suggestions, AI features and accessories', [
    'com.google.android.apps.wellbeing',
    'com.google.android.settings.intelligence',
    'com.android.emulator.multidisplay',
    'com.google.android.apps.bard',
    'com.google.android.apps.restore',
    'com.google.android.apps.pulse',
    'com.google.android.configupdater',
    'com.google.android.projection.gearhead',
    'com.google.android.healthconnect.controller',
    'com.android.imsserviceentitlement',
    'com.android.carrierdefaultapp',
    'com.google.android.ondevicepersonalization.services',
    'com.google.android.federatedcompute',
    'com.google.android.glasses.companion',
    'com.google.android.glasses.core',
    'com.google.android.apps.safetyhub',
    'com.google.android.markup',
  ]),
  category('media-apps', 'standard', 'Preinstalled media and consumer apps (photos, video, music, maps, email, camera)', [
    'com.google.android.apps.photos',
    'com.google.android.youtube',
    'com.google.android.videos',
    'com.google.android.music',
    'com.google.android.apps.youtube.music',
    'com.google.android.apps.maps',
    'com.google.android.gm',
    'com.google.android.apps.docs',
    'com.android.gallery3d',
    'com.android.music',
    'com.android.camera2',
    'com.android.cameraextensions',
    'com.android.DeviceAsWebcam',
  ]),
  category('telephony', 'standard', 'Phone, SMS, contacts, emergency alerts and satellite', [
    'com.google.android.apps.messaging',
    'com.google.android.dialer',
    'com.google.android.contacts',
    'com.android.mms',
    'com.android.dialer',
    'com.android.contacts',
    'com.google.android.cellbroadcastservice',
    'com.android.cellbroadcastreceiver',
    'com.google.android.telephony.satellite',
    'com.android.stk',
  ]),
  category('accessibility-speech', 'standard', 'Text-to-speech and accessibility services', [
    'com.google.android.tts',
    'com.google.android.marvin.talkback',
    'com.google.android.apps.accessibility.voiceaccess',
  ]),
  category('printing', 'standard', 'Printing and spoolers', [
    'com.android.printspooler',
    'com.android.bips',
    'com.google.android.printservice.recommendation',
  ]),
  category('feedback-extras', 'standard', 'Feedback, tracing, screen savers, wallpaper and utility apps', [
    'com.google.android.feedback',
    'com.android.traceur',
    'com.android.dreams.basic',
    'com.android.dreams.phototable',
    'com.android.wallpaper.livepicker',
    'com.google.android.apps.wallpaper',
    'com.android.emergency',
    'com.android.calendar',
    'com.google.android.calendar',
    'com.android.deskclock',
    'com.google.android.deskclock',
    'com.android.calculator2',
    'com.google.android.calculator',
  ]),
  // The source also lists com.android.chrome; removed (NEVER_DISABLE).
  category('store-setup', 'aggressive', 'Play Store (background updater) and initial setup wizards', [
    PLAY_STORE,
    'com.google.android.partnersetup',
    'com.google.android.setupwizard',
    'com.android.setupwizard',
  ]),
  category('on-screen-keyboard', 'aggressive', 'On-screen keyboard (Gboard); text still arrives via adb/argent input', [GBOARD]),
]);

const LEVEL_RANK: Readonly<Record<BloatLevel, number>> = Object.freeze({ standard: 0, aggressive: 1 });

// Managed packages up to the requested level, deduplicated, in category order.
export function managedPackages(level: BloatLevel = 'aggressive'): string[] {
  const out = new Set<string>();
  for (const cat of BLOAT_CATEGORIES) {
    if (LEVEL_RANK[cat.level] <= LEVEL_RANK[level]) for (const p of cat.packages) out.add(p);
  }
  return [...out];
}

// managed(level) AND installed, minus NEVER_DISABLE, minus kept by capability.
export function planDisable(opts: {
  installed: readonly string[];
  level: BloatLevel;
  capabilities?: readonly Capability[];
}): string[] {
  const installed = new Set(opts.installed);
  const blocked = new Set(NEVER_DISABLE);
  for (const cap of opts.capabilities ?? []) for (const p of KEPT_BY_CAPABILITY[cap] ?? []) blocked.add(p);
  return managedPackages(opts.level).filter((p) => installed.has(p) && !blocked.has(p));
}

// Only re-enables what we disabled and what belongs to the managed list.
export function planRestore(savedDisabled: readonly string[]): string[] {
  const managed = new Set(managedPackages('aggressive'));
  return [...new Set(savedDisabled)].filter((p) => managed.has(p));
}
