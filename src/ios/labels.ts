import type { Capability } from '../capabilities.ts';
import { DevslimError } from '../errors.ts';

// Labels launchd `com.apple.*` que o perfil iOS pode desligar, agrupados em
// categorias. Labels e agrupamento transcritos do simslim (profiles.go, MIT,
// ver NOTICE); textos de "o que quebra" com redacao propria.
//
// Um label pode aparecer em mais de uma categoria (um daemon serve mais de um
// recurso). Categoria mantida (por `except` ou por capacidade) mantem TODOS os
// seus labels ligados, mesmo os que outra categoria tambem lista.

export const CATEGORY_IDS = Object.freeze([
  'widgets',
  'siri',
  'search',
  'icloud',
  'store',
  'pim',
  'web',
  'family',
  'health',
  'photos',
  'apps',
  'messaging',
  'connectivity',
  'telemetry',
  'mdm',
  'other',
] as const);
export type CategoryId = (typeof CATEGORY_IDS)[number];

const f = <T>(list: readonly T[]): readonly T[] => Object.freeze([...list]);

export const CATEGORIES: Readonly<Record<CategoryId, readonly string[]>> = Object.freeze({
  widgets: f([
    'com.apple.PosterBoard',
    'com.apple.chronod',
    'com.apple.liveactivitiesd',
    'com.apple.navd', // tambem em connectivity: o widget de Mapas fica em loop sem ele
  ]),
  siri: f([
    'com.apple.assistant_cdmd',
    'com.apple.assistant_service',
    'com.apple.siriactionsd',
    'com.apple.siriinferenced',
    'com.apple.siriknowledged',
    'com.apple.sirittsd',
    'com.apple.siri.context.service',
    'com.apple.siri.acousticsignature',
    'com.apple.corespeechd',
    'com.apple.voiced',
    'com.apple.voicebankingd',
    'com.apple.speechmodeltrainingd',
    'com.apple.intelligenceplatformd',
    'com.apple.intelligencecontextd',
    'com.apple.intelligenceflowd',
    'com.apple.intelligencetasksd',
    'com.apple.generativeexperiencesd',
    'com.apple.knowledgeconstructiond',
    'com.apple.naturallanguaged',
    'com.apple.textunderstandingd',
    'com.apple.modelcatalogd',
    'com.apple.modelmanagerd',
    'com.apple.mlhostd',
    'com.apple.mlruntimed',
    'com.apple.suggestd',
    'com.apple.parsecd',
    'com.apple.parsec-fbf',
    'com.apple.proactiveeventtrackerd',
  ]),
  search: f([
    'com.apple.searchd',
    'com.apple.searchtoold',
    'com.apple.spotlightknowledged',
    'com.apple.spotlightknowledged.updater',
    'com.apple.corespotlightservice',
  ]),
  icloud: f([
    'com.apple.appleaccountd',
    'com.apple.appleaccounttransparencyd',
    'com.apple.appleidsetupd',
    'com.apple.akd',
    'com.apple.amsaccountsd',
    'com.apple.amsengagementd',
    'com.apple.amsondevicestoraged',
    'com.apple.cloudd',
    'com.apple.cloudphotod',
    'com.apple.ckdiscretionaryd',
    'com.apple.cloudsettingssyncagent',
    'com.apple.bird',
    'com.apple.syncdefaultsd',
    'com.apple.cdpd',
    'com.apple.sosd',
    'com.apple.SecureBackupDaemon',
    'com.apple.TrustedPeersHelper',
    'com.apple.protectedcloudstorage.protectedcloudkeysyncing',
    'com.apple.icloudmailagent',
    'com.apple.icloudsubscriptionoptimizerd',
    'com.apple.communicationtrustd',
  ]),
  store: f([
    'com.apple.appstored',
    'com.apple.appstorecomponentsd',
    'com.apple.apsd',
    'com.apple.itunescloudd',
    'com.apple.itunesstored',
    'com.apple.storekitd',
    // folha de pagamento do StoreKit (AMS); tambem em icloud
    'com.apple.amsaccountsd',
    'com.apple.amsengagementd',
    'com.apple.amsondevicestoraged',
    // Wallet hospeda a folha de pagamento e depende do financed; tambem em other
    'com.apple.passd',
    'com.apple.financed',
    'com.apple.videosubscriptionsd',
    'com.apple.assetsubscriptiond',
    'com.apple.musicd',
  ]),
  pim: f([
    'com.apple.email.maild',
    'com.apple.exchangesyncd',
    'com.apple.dataaccess.dataaccessd',
    'com.apple.calaccessd',
    'com.apple.remindd',
    'com.apple.contactsd',
    'com.apple.contacts.postersyncd',
    'com.apple.peopled',
  ]),
  web: f([
    'com.apple.SafariBookmarksSyncAgent',
    'com.apple.Safari.History',
    'com.apple.Safari.passwordbreachd',
    'com.apple.Safari.SafeBrowsing.Service',
    'com.apple.safarifetcherd',
    'com.apple.WebBookmarks.webbookmarksd',
    'com.apple.webkit.adattributiond',
    'com.apple.webkit.webpushd',
    'com.apple.webprivacyd',
    'com.apple.swcd',
  ]),
  family: f([
    'com.apple.familycircled',
    'com.apple.FamilyControlsAgent',
    'com.apple.familynotification',
    'com.apple.askpermissiond',
    'com.apple.asktod',
    'com.apple.ScreenTimeAgent',
    'com.apple.ScreenTimeSettingsAgent',
    'com.apple.UsageTrackingAgent',
  ]),
  health: f([
    'com.apple.healthd',
    'com.apple.healthappd',
    'com.apple.healthcontentd',
    'com.apple.healtheventsd',
    'com.apple.healthrecordsd',
    'com.apple.finhealthd',
    'com.apple.homed',
    'com.apple.homeeventsd',
    'com.apple.fitcore',
    'com.apple.fitcore.session',
    'com.apple.fitnesscoachingd',
    'com.apple.fitnessintelligenced',
    'com.apple.activityawardsd',
    'com.apple.activitysharingd',
  ]),
  photos: f([
    'com.apple.photoanalysisd',
    'com.apple.photosface',
    'com.apple.mediaanalysisd',
    'com.apple.mediaanalysisd.service',
    'com.apple.mediastream.mstreamd',
    'com.apple.medialibraryd',
    'com.apple.assetsd',
    'com.apple.assetsd.nebulad',
  ]),
  apps: f([
    'com.apple.newsd',
    'com.apple.weatherd',
    'com.apple.Maps.mapssyncd',
    'com.apple.Maps.mapspushd',
    'com.apple.Maps.geocorrectiond',
    'com.apple.maps.destinationd',
    'com.apple.MapKit.SnapshotService',
    'com.apple.jetpackassetd',
    'com.apple.tipsd',
    'com.apple.gamesaved',
    'com.apple.GameController.gamecontrollerd',
  ]),
  messaging: f([
    'com.apple.identityservicesd',
    'com.apple.ids_simd',
    'com.apple.imautomatichistorydeletionagent',
    'com.apple.imcore.imtransferagent',
    'com.apple.imdpersistence.IMDPersistenceAgent',
    'com.apple.facetimemessagestored',
    'com.apple.telephonyutilities.callservicesd',
  ]),
  connectivity: f([
    'com.apple.rapportd',
    'com.apple.companiond',
    'com.apple.carkitd',
    'com.apple.wcd',
    'com.apple.tvremoted',
    'com.apple.avatarsd',
    'com.apple.stickersd',
    'com.apple.sociallayerd',
    'com.apple.announced',
    'com.apple.navd',
    'com.apple.findmy.findmylocated',
  ]),
  telemetry: f([
    'com.apple.ap.adprivacyd',
    'com.apple.ap.promotedcontentd',
    'com.apple.diagnosticextensionsd',
    'com.apple.feedbackd',
    'com.apple.rtcreportingd',
    'com.apple.securityuploadd',
    'com.apple.geoanalyticsd',
    'com.apple.triald',
    'com.apple.followupd',
    'com.apple.purplebuddy.budd',
    'com.apple.devicecheckd',
  ]),
  mdm: f(['com.apple.remotemanagementd', 'com.apple.RemoteManagementAgent', 'com.apple.managedassetsd']),
  other: f([
    'com.apple.financed',
    'com.apple.passd',
    'com.apple.merchantd',
    'com.apple.coreidvd',
    'com.apple.businessservicesd',
    'com.apple.deviceaccessd',
    'com.apple.replicatord',
    'com.apple.linkd',
    'com.apple.ind',
    'com.apple.storagedatad',
    'com.apple.StatusKitAgent',
    'com.apple.countryd',
    'com.apple.mobileassetd',
    'com.apple.managedconfiguration.passcodenagd',
    'com.apple.accessibility.axassetsd',
    'com.apple.ClipServices.clipserviced',
  ]),
});

// O que para de funcionar quando a categoria fica desligada (redacao propria).
export const CATEGORY_BREAKS: Readonly<Record<CategoryId, string>> = Object.freeze({
  widgets: 'widgets, papel de parede (posters) e Live Activities param de atualizar',
  siri: 'Siri, ditado/fala e Apple Intelligence indisponiveis',
  search: 'Spotlight e busca dos Ajustes vazios; Recentes do Arquivos e do seletor de documentos nao carregam',
  icloud: 'iCloud, conta Apple (login Apple ID), Keychain e backup',
  store: 'push remoto, StoreKit (compra no app) e App Store',
  pim: 'Contatos, Calendario, Lembretes e Mail (e seletores que dependem deles)',
  web: 'universal links (associated domains), sync do Safari e web push',
  family: 'Compartilhamento Familiar e Tempo de Uso',
  health: 'HealthKit, HomeKit e Fitness',
  photos: 'biblioteca de Fotos, seletor de fotos e analise de midia',
  apps: 'dados de fundo de News, Tempo e Mapas; controles de jogo',
  messaging: 'iMessage, FaceTime e servicos de identidade',
  connectivity: 'AirDrop, Continuidade, CarPlay, Watch e Buscar',
  telemetry: 'DeviceCheck, analytics, diagnosticos e Feedback',
  mdm: 'gerenciamento declarativo de device (MDM, perfis de configuracao)',
  other: 'Wallet, App Clips, assets de acessibilidade e servicos diversos de fundo',
});

// Nunca desligados, mesmo listados ao lado de uma categoria no simslim:
// assistantd (ditado; sem ele o Spotlight vaza memoria), gamed (launch de app
// via XCUITest), sharingd (folha de compartilhar).
export const ALWAYS_ENABLED = Object.freeze([
  'com.apple.assistantd',
  'com.apple.gamed',
  'com.apple.sharingd',
] as const);

// Travam ou derrubam o simulador quando desligados (profiles_test.go do simslim).
// Nenhum pode aparecer em categoria (teste de invariante).
export const FORBIDDEN = Object.freeze([
  'com.apple.nanoregistryd',
  'com.apple.nanoregistrylaunchd',
  'com.apple.nanoprefsyncd.2',
  'com.apple.nanotimekitcompaniond',
  'com.apple.nanobackupd',
  'com.apple.sleepd',
  'com.apple.appprotectiond',
  'com.apple.ManagedSettingsAgent',
  'com.apple.managedconfiguration.profiled',
  'com.apple.mobiletimerd',
  'com.apple.routined',
  'com.apple.biomed',
  'com.apple.biomesyncd',
  'com.apple.dmd',
  'com.apple.donotdisturbd',
] as const);

// Capacidade -> o que ela mantem ligado. Conferido com features.go do simslim:
// push = apsd; StoreKit = storekitd, itunesstored, ams*, passd, financed (todos
// na categoria store); App Store = appstored, itunesstored; universal links =
// swcd (categoria web); Fotos = assetsd, photoanalysisd (categoria photos).
// location: CoreLocation (com.apple.locationd) e GeoServices (com.apple.geod,
// tiles e geocoding do MapKit) nao estao na lista gerida, entao nunca sao
// desligados. Da lista, so MapKit.SnapshotService e do framework publico
// (MapKit.framework/XPCServices, usado pelo MKMapSnapshotter); navd,
// destinationd, Maps.* e geoanalyticsd servem o app Mapas, widgets ou telemetria.
export const CAPABILITY_KEEPS: Readonly<Record<Capability, Readonly<{ categories: readonly CategoryId[]; labels: readonly string[] }>>> =
  Object.freeze({
    audio: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }),
    camera: Object.freeze({ categories: f<CategoryId>(['photos']), labels: f<string>([]) }),
    keyboard: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }), // so Android (Gboard)
    location: Object.freeze({ categories: f<CategoryId>([]), labels: f(['com.apple.MapKit.SnapshotService']) }),
    push: Object.freeze({ categories: f<CategoryId>([]), labels: f(['com.apple.apsd']) }),
    store: Object.freeze({ categories: f<CategoryId>(['store', 'icloud']), labels: f<string>([]) }),
    weblogin: Object.freeze({ categories: f<CategoryId>(['web']), labels: f<string>([]) }),
    window: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }), // so abre o Simulator.app no `up`
  });

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}

// Universo de labels que o devslim pode mexer: uniao das categorias menos
// ALWAYS_ENABLED. Qualquer leitura ou escrita fora disso e ignorada/recusada.
export function managedSet(): Set<string> {
  const set = new Set<string>();
  for (const id of CATEGORY_IDS) for (const l of CATEGORIES[id]) set.add(l);
  for (const l of ALWAYS_ENABLED) set.delete(l);
  return set;
}

// Reparo: ALWAYS_ENABLED que o store traz desligados (herdado de outra
// ferramenta) sao gravados como ligados (<false/>) no `up`, com backup, e
// voltam ao valor salvo no `off`. O devslim nunca os desliga; `except`/`keep`
// nao alcancam o reparo (keep so aceita labels do managedSet).
export function repairSet(): Set<string> {
  return new Set<string>(ALWAYS_ENABLED);
}

// Tudo que o devslim pode tocar: managedSet() (desligar/devolver) mais
// repairSet() (so religar/devolver). Fora disso, nada e lido para diff nem escrito.
export function touchableSet(): Set<string> {
  const set = managedSet();
  for (const l of repairSet()) set.add(l);
  return set;
}

export type LabelsToDisableOptions = {
  capabilities?: readonly Capability[];
  except?: readonly string[]; // ids de categoria mantidos ligados
  keep?: readonly string[]; // labels avulsos mantidos ligados
};

// Valida e normaliza `except` (ids de categoria) e `keep` (labels geridos).
export function validateExcept(except: readonly string[] = []): CategoryId[] {
  const out: CategoryId[] = [];
  for (const id of except) {
    if (!isCategoryId(id)) throw new DevslimError(`categoria desconhecida: ${id} (validas: ${CATEGORY_IDS.join(', ')})`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function validateKeep(keep: readonly string[] = []): string[] {
  const managed = managedSet();
  const out: string[] = [];
  for (const l of keep) {
    if (!managed.has(l)) throw new DevslimError(`label fora da lista gerida: ${l} (ver devslim ios categories)`);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

// managedSet menos o que as capacidades religam, menos categorias em `except`,
// menos labels em `keep`. Ordenado.
export function labelsToDisable(opts: LabelsToDisableOptions = {}): string[] {
  const set = managedSet();
  const cats = new Set<CategoryId>(validateExcept(opts.except));
  const keep = new Set<string>(validateKeep(opts.keep));
  for (const cap of opts.capabilities ?? []) {
    const k = CAPABILITY_KEEPS[cap];
    if (k === undefined) throw new DevslimError(`capacidade desconhecida: ${cap}`);
    for (const c of k.categories) cats.add(c);
    for (const l of k.labels) keep.add(l);
  }
  for (const c of cats) for (const l of CATEGORIES[c]) set.delete(l);
  for (const l of keep) set.delete(l);
  return [...set].sort();
}
