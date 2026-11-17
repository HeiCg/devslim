import type { Capability } from '../capabilities.ts';
import { DevslimError } from '../errors.ts';

// launchd `com.apple.*` labels the iOS profile can disable, grouped into
// categories. Labels and grouping transcribed from simslim (profiles.go, MIT,
// see NOTICE); the "what breaks" texts are our own wording.
//
// A label can appear in more than one category (one daemon serves more than one
// feature). A kept category (via `except` or a capability) keeps ALL of its
// labels enabled, even those another category also lists.

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
    'com.apple.navd', // also in connectivity: the Maps widget loops without it
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
    // StoreKit payment sheet (AMS); also in icloud
    'com.apple.amsaccountsd',
    'com.apple.amsengagementd',
    'com.apple.amsondevicestoraged',
    // Wallet hosts the payment sheet and depends on financed; also in other
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

// What stops working when the category is disabled (our own wording).
export const CATEGORY_BREAKS: Readonly<Record<CategoryId, string>> = Object.freeze({
  widgets: 'widgets, wallpaper (posters) and Live Activities stop updating',
  siri: 'Siri, dictation/speech and Apple Intelligence unavailable',
  search: 'Spotlight and Settings search empty; Recents in Files and the document picker do not load',
  icloud: 'iCloud, Apple account (Apple ID sign-in), Keychain and backup',
  store: 'remote push, StoreKit (in-app purchase) and App Store',
  pim: 'Contacts, Calendar, Reminders and Mail (and pickers that depend on them)',
  web: 'universal links (associated domains), Safari sync and web push',
  family: 'Family Sharing and Screen Time',
  health: 'HealthKit, HomeKit and Fitness',
  photos: 'Photos library, photo picker and media analysis',
  apps: 'background data for News, Weather and Maps; game controllers',
  messaging: 'iMessage, FaceTime and identity services',
  connectivity: 'AirDrop, Continuity, CarPlay, Watch and Find My',
  telemetry: 'DeviceCheck, analytics, diagnostics and Feedback',
  mdm: 'declarative device management (MDM, configuration profiles)',
  other: 'Wallet, App Clips, accessibility assets and miscellaneous background services',
});

// Never disabled, even when listed next to a category in simslim:
// assistantd (dictation; without it Spotlight leaks memory), gamed (app launch
// via XCUITest), sharingd (share sheet).
export const ALWAYS_ENABLED = Object.freeze([
  'com.apple.assistantd',
  'com.apple.gamed',
  'com.apple.sharingd',
] as const);

// Hang or crash the simulator when disabled (simslim profiles_test.go).
// None may appear in a category (invariant test).
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

// Capability -> what it keeps enabled. Checked against simslim features.go:
// push = apsd; StoreKit = storekitd, itunesstored, ams*, passd, financed (all
// in the store category); App Store = appstored, itunesstored; universal links =
// swcd (web category); Photos = assetsd, photoanalysisd (photos category).
// location: CoreLocation (com.apple.locationd) and GeoServices (com.apple.geod,
// MapKit tiles and geocoding) are not in the managed list, so they are never
// disabled. From the list, only MapKit.SnapshotService belongs to the public framework
// (MapKit.framework/XPCServices, used by MKMapSnapshotter); navd,
// destinationd, Maps.* and geoanalyticsd serve the Maps app, widgets or telemetry.
export const CAPABILITY_KEEPS: Readonly<Record<Capability, Readonly<{ categories: readonly CategoryId[]; labels: readonly string[] }>>> =
  Object.freeze({
    audio: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }),
    camera: Object.freeze({ categories: f<CategoryId>(['photos']), labels: f<string>([]) }),
    keyboard: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }), // Android only (Gboard)
    location: Object.freeze({ categories: f<CategoryId>([]), labels: f(['com.apple.MapKit.SnapshotService']) }),
    push: Object.freeze({ categories: f<CategoryId>([]), labels: f(['com.apple.apsd']) }),
    store: Object.freeze({ categories: f<CategoryId>(['store', 'icloud']), labels: f<string>([]) }),
    weblogin: Object.freeze({ categories: f<CategoryId>(['web']), labels: f<string>([]) }),
    window: Object.freeze({ categories: f<CategoryId>([]), labels: f<string>([]) }), // only opens Simulator.app on `up`
  });

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}

// Universe of labels devslim may touch: union of the categories minus
// ALWAYS_ENABLED. Any read or write outside it is ignored/refused.
export function managedSet(): Set<string> {
  const set = new Set<string>();
  for (const id of CATEGORY_IDS) for (const l of CATEGORIES[id]) set.add(l);
  for (const l of ALWAYS_ENABLED) set.delete(l);
  return set;
}

// Repair: ALWAYS_ENABLED labels the store has disabled (inherited from another
// tool) are written as enabled (<false/>) on `up`, with a backup, and
// return to the saved value on `off`. devslim never disables them; `except`/`keep`
// do not reach the repair (keep only accepts labels from managedSet).
export function repairSet(): Set<string> {
  return new Set<string>(ALWAYS_ENABLED);
}

// Everything devslim may touch: managedSet() (disable/restore) plus
// repairSet() (only re-enable/restore). Outside it, nothing is read for diff or written.
export function touchableSet(): Set<string> {
  const set = managedSet();
  for (const l of repairSet()) set.add(l);
  return set;
}

export type LabelsToDisableOptions = {
  capabilities?: readonly Capability[];
  except?: readonly string[]; // category ids kept enabled
  keep?: readonly string[]; // individual labels kept enabled
};

// Validates and normalizes `except` (category ids) and `keep` (managed labels).
export function validateExcept(except: readonly string[] = []): CategoryId[] {
  const out: CategoryId[] = [];
  for (const id of except) {
    if (!isCategoryId(id)) throw new DevslimError(`unknown category: ${id} (valid: ${CATEGORY_IDS.join(', ')})`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function validateKeep(keep: readonly string[] = []): string[] {
  const managed = managedSet();
  const out: string[] = [];
  for (const l of keep) {
    if (!managed.has(l)) throw new DevslimError(`label outside the managed list: ${l} (see devslim ios categories)`);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

// managedSet minus what the capabilities re-enable, minus categories in `except`,
// minus labels in `keep`. Sorted.
export function labelsToDisable(opts: LabelsToDisableOptions = {}): string[] {
  const set = managedSet();
  const cats = new Set<CategoryId>(validateExcept(opts.except));
  const keep = new Set<string>(validateKeep(opts.keep));
  for (const cap of opts.capabilities ?? []) {
    const k = CAPABILITY_KEEPS[cap];
    if (k === undefined) throw new DevslimError(`unknown capability: ${cap}`);
    for (const c of k.categories) cats.add(c);
    for (const l of k.labels) keep.add(l);
  }
  for (const c of cats) for (const l of CATEGORIES[c]) set.delete(l);
  for (const l of keep) set.delete(l);
  return [...set].sort();
}
