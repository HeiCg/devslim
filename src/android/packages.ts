import type { Capability } from '../capabilities.ts';

// Lista gerida de bloat do guest Android.
// Nomes de pacote e agrupamento transcritos de kdbhalala/avdslim
// (internal/bloat/packages.go, MIT; ver NOTICE). Descricoes com redacao
// propria. Nada aqui foi validado contra uma imagem real: o debloat (T2)
// cruza com `pm list packages` antes de desligar.

export type BloatLevel = 'standard' | 'aggressive';

export type BloatCategory = Readonly<{
  id: string;
  level: BloatLevel;
  description: string;
  packages: readonly string[];
}>;

// Pacotes que nunca desligamos, mesmo que aparecam em alguma lista de origem.
// bluetooth: system_server entra em crash-loop no Android 16+ sem ele.
// chrome: expo-web-browser e OAuth dependem dele.
export const NEVER_DISABLE: readonly string[] = Object.freeze([
  'com.google.android.bluetooth',
  'com.android.chrome',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.webview',
  'com.android.systemui',
  'com.android.settings',
  'com.android.providers.settings',
  'com.google.android.inputmethod.latin',
  'com.android.inputmethod.latin',
  'com.android.shell',
]);

export const PLAY_STORE = 'com.android.vending';

// Religados por capacidade: a capacidade presente tira o pacote do plano.
export const KEPT_BY_CAPABILITY: Readonly<Partial<Record<Capability, readonly string[]>>> = Object.freeze({
  camera: Object.freeze(['com.android.camera2', 'com.android.cameraextensions']),
  store: Object.freeze([PLAY_STORE]),
});

function category(id: string, level: BloatLevel, description: string, packages: string[]): BloatCategory {
  return Object.freeze({ id, level, description, packages: Object.freeze(packages) });
}

export const BLOAT_CATEGORIES: readonly BloatCategory[] = Object.freeze([
  category('assistant-search', 'standard', 'Assistente do Google, busca e servicos de IA em segundo plano', [
    'com.google.android.googlequicksearchbox',
    'com.google.android.as',
    'com.google.android.as.oss',
  ]),
  category('bluetooth-peripherals', 'standard', 'Servico MIDI via Bluetooth (o APK de Bluetooth em si nunca entra)', [
    'com.android.bluetoothmidiservice',
  ]),
  category('ads-measurement', 'standard', 'Privacy Sandbox e medicao de anuncios', [
    'com.google.android.adservices.api',
    'com.google.mainline.adservices',
  ]),
  category('wellbeing-intelligence', 'standard', 'Bem-estar digital, sugestoes inteligentes, recursos de IA e acessorios', [
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
  category('media-apps', 'standard', 'Apps de midia e de consumo pre-instalados (fotos, video, musica, mapas, email, camera)', [
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
  category('telephony', 'standard', 'Telefone, SMS, contatos, alertas de emergencia e satelite', [
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
  category('accessibility-speech', 'standard', 'Sintese de voz e servicos de acessibilidade', [
    'com.google.android.tts',
    'com.google.android.marvin.talkback',
    'com.google.android.apps.accessibility.voiceaccess',
  ]),
  category('printing', 'standard', 'Impressao e spoolers', [
    'com.android.printspooler',
    'com.android.bips',
    'com.google.android.printservice.recommendation',
  ]),
  category('feedback-extras', 'standard', 'Feedback, rastreamento, protetores de tela, papel de parede e apps utilitarios', [
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
  // Na origem tambem consta com.android.chrome; removido (NEVER_DISABLE).
  category('store-setup', 'aggressive', 'Play Store (atualizador em segundo plano) e assistentes de configuracao inicial', [
    PLAY_STORE,
    'com.google.android.partnersetup',
    'com.google.android.setupwizard',
    'com.android.setupwizard',
  ]),
]);

const LEVEL_RANK: Readonly<Record<BloatLevel, number>> = Object.freeze({ standard: 0, aggressive: 1 });

// Pacotes geridos ate o nivel pedido, sem duplicatas, na ordem das categorias.
export function managedPackages(level: BloatLevel = 'aggressive'): string[] {
  const out = new Set<string>();
  for (const cat of BLOAT_CATEGORIES) {
    if (LEVEL_RANK[cat.level] <= LEVEL_RANK[level]) for (const p of cat.packages) out.add(p);
  }
  return [...out];
}

// gerida(nivel) ∩ instalados − NEVER_DISABLE − religados por capacidade.
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

// So reabilita o que nos desligamos e que pertence a lista gerida.
export function planRestore(savedDisabled: readonly string[]): string[] {
  const managed = new Set(managedPackages('aggressive'));
  return [...new Set(savedDisabled)].filter((p) => managed.has(p));
}
