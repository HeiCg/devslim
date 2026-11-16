// API publica da lib devslim. A CLI (src/cli.ts) e uma camada fina por cima.
export { DevslimError, UsageError } from './errors.ts';
export { writeFileAtomic } from './fsAtomic.ts';
export { nodeExec, createFakeExec, nodeSpawnDetached, createFakeSpawnDetached } from './exec.ts';
export type {
  Exec,
  ExecOptions,
  ExecResult,
  FakeCall,
  FakeHandler,
  SpawnDetached,
  SpawnDetachedOptions,
  FakeSpawnCall,
} from './exec.ts';
export {
  devslimHome,
  statePath,
  saveState,
  loadState,
  clearState,
  listStates,
  recordAndroidTune,
  recordAndroidGuest,
  recordIosBackup,
} from './state.ts';
export type { AndroidState, IosState, IosProfileRecord, Platform, StateOptions } from './state.ts';
export {
  CAPABILITIES,
  isCapability,
  sortCapabilities,
  parseCapabilities,
  deriveCapabilities,
  readPackageJson,
  resolveCapabilities,
} from './capabilities.ts';
export type { Capability } from './capabilities.ts';

export {
  buildAndroidProfile,
  parseScreen,
  formatScreen,
  hasCapability,
  RAM_MIN_MB,
  RAM_MAX_MB,
  DEFAULT_RAM_MB,
  AGGRESSIVE_RAM_MB,
  HEAP_MB,
  CORES,
  PORT_MIN,
  PORT_MAX,
  GPU_MODES,
} from './android/profile.ts';
export type { AndroidProfile, AndroidProfileOptions, Screen, ScreenSpec } from './android/profile.ts';
export {
  parseIni,
  serializeIni,
  getValue,
  setValue,
  entryKeys,
  managedValues,
  applyProfile,
} from './android/configIni.ts';
export type { IniDoc, IniLine, IniEntry, IniOther, IniChange } from './android/configIni.ts';
export { buildLaunchArgs, grpcPortFor, GRPC_BASE_PORT, GRPC_REFERENCE_PORT, SLIM_SNAPSHOT, FORBIDDEN_SNAPSHOT } from './android/launchArgs.ts';
export { runningDir, parseRunningIni, readRunningEntries, isAdvertised, findRunningEntry } from './android/runningIni.ts';
export type { RunningEntry } from './android/runningIni.ts';
export {
  BLOAT_CATEGORIES,
  NEVER_DISABLE,
  PLAY_STORE,
  KEPT_BY_CAPABILITY,
  managedPackages,
  planDisable,
  planRestore,
} from './android/packages.ts';
export type { BloatCategory, BloatLevel } from './android/packages.ts';
export {
  avdHome,
  listAvds,
  findAvd,
  runningLocks,
  isAvdRunning,
  existingRegenerated,
  REGENERATED_ARTIFACTS,
} from './android/avd.ts';
export type { AvdInfo } from './android/avd.ts';
export { planTune, tuneAvd, restoreAvd } from './android/tune.ts';
export type { TunePlan, TuneResult, RestoreResult, RestoreOptions, TuneContext } from './android/tune.ts';

// Runtime Android (fala com adb/emulator/avdmanager via Exec injetavel).
export { findSdkTool, findSdkRoot, sdkToolPath, sdkCandidates, defaultFileExists } from './android/sdk.ts';
export type { SdkTool, SdkOptions } from './android/sdk.ts';
export {
  createAdb,
  parseAdbDevices,
  serialForPort,
  portForSerial,
  isSafeSettingValue,
  realSleep,
  DEFAULT_BOOT_TIMEOUT_MS,
  DEFAULT_EXIT_TIMEOUT_MS,
} from './android/adb.ts';
export type { Adb, AdbDevice, AdbOptions, PackageBatch, PackageFailure, SettingsNamespace, Sleep } from './android/adb.ts';
export { createFakeAndroid } from './android/fakeAndroid.ts';
export type { FakeAndroid, FakeAndroidOptions, FakeEmulator, FakeEmulatorInit } from './android/fakeAndroid.ts';
export { resolveRuntime } from './android/deps.ts';
export type { Runtime, RuntimeContext } from './android/deps.ts';
export { slimRunningDevice, unslimRunningDevice, SLIM_SETTINGS, DEXOPT_TIMEOUT_MS } from './android/slim.ts';
export type { SavedSetting, SlimOptions, SlimReport, UnslimReport, SettingOutcome, StepOutcome } from './android/slim.ts';
export {
  sessionPath,
  loadSession,
  recordSession,
  removeSession,
  runningEmulators,
  bootedSimulators,
  parseSimctlBooted,
  assertSingleDevice,
  findAvdSerial,
  waitForExit,
  parseSwapUsage,
  swapWarning,
  SWAP_WARN_RATIO,
} from './android/session.ts';
export type { SessionEntry, BootedSimulator, DeviceCensus, SwapUsage } from './android/session.ts';
export {
  upAvd,
  bakeAvd,
  downAvd,
  createAvd,
  pickFreePort,
  ramFloorWarning,
  offProfileWarning,
  bakeHint,
  notAdvertisedWarning,
  ADVERTISE_TIMEOUT_MS,
  ADVERTISE_POLL_MS,
  FLOOR_SCREEN_TRY,
  hasSlimSnapshot,
  slimSnapshotDir,
  logFileFor,
  DEFAULT_IMAGE,
  DEFAULT_DEVICE,
  CREATE_SCREEN,
} from './android/runtime.ts';
export type { UpOptions, UpResult, BakeOptions, BakeResult, DownOutcome, CreateResult } from './android/runtime.ts';
export {
  measureAvd,
  measureAndroidHost,
  measureAndroidGuest,
  findQemuPid,
  parseFootprintMb,
  parsePhysFootprintMb,
  parseFootprintHeaderMb,
  parseRssMb,
  parseProcMeminfo,
  parseDumpsysMeminfo,
  countPsProcesses,
  measureSim,
  parseTopMem,
  parsePsTable,
  processTree,
} from './measure.ts';
export type { AndroidMeasurement, HostMeasure, GuestMeasure, IosMeasurement, PsEntry } from './measure.ts';

// iOS (simulador): labels launchd geridos, store disabled.plist, simctl, up/off.
export {
  CATEGORY_IDS,
  CATEGORIES,
  CATEGORY_BREAKS,
  ALWAYS_ENABLED,
  FORBIDDEN,
  CAPABILITY_KEEPS,
  isCategoryId,
  managedSet,
  repairSet,
  touchableSet,
  labelsToDisable,
  validateExcept,
  validateKeep,
} from './ios/labels.ts';
export type { CategoryId, LabelsToDisableOptions } from './ios/labels.ts';
export {
  DEFAULT_STORE_BASE,
  UDID_RE,
  assertUdid,
  storeDir,
  storePath,
  parseStorePlist,
  serializeStorePlist,
  readStore,
  mergeStore,
} from './ios/disabledStore.ts';
export type { StoreOptions } from './ios/disabledStore.ts';
export {
  createSimctl,
  parseDevicesJson,
  parseRuntimesJson,
  parseRuntimeId,
  resolveDevice,
  parsePrintDisabled,
  isLaunchdSettling,
  LAUNCHD_RETRY_DELAYS_MS,
  DEFAULT_BOOTSTATUS_TIMEOUT_MS,
} from './ios/simctl.ts';
export type { Simctl, SimctlOptions, SimDevice, SimRuntime } from './ios/simctl.ts';
export {
  planSim,
  upSim,
  offSim,
  downSim,
  checkIosRuntime,
  compareVersion,
  runPool,
  MIN_IOS_VERSION,
  FALLBACK_POOL,
  FALLBACK_PASSES,
} from './ios/slim.ts';
export type {
  IosContext,
  IosSlimOptions,
  SimPlan,
  UpSimResult,
  OffSimResult,
  DownSimOutcome,
  FallbackReport,
  RuntimeInfo,
} from './ios/slim.ts';
export { createFakeIos, FAKE_RUNTIME_ID, FAKE_SDK } from './ios/fakeIos.ts';
export type { FakeIos, FakeIosOptions, FakeSim, FakeSimInit } from './ios/fakeIos.ts';

// Comandos transversais: status, doctor, down e measure de topo.
export { collectStatus, statusText, avdLiveness, sessionStatus, listSimDevices, readSwap } from './status.ts';
export type { StatusReport, IosStatus, AndroidStatus, SessionStatus, SwapStatus, AvdLiveness } from './status.ts';
export {
  runDoctor,
  doctorExitCode,
  doctorText,
  dirSize,
  parseRamMb,
  isSoftwareGpu,
  MIN_NODE_MAJOR,
  MIN_EMULATOR_REVISION,
  RAM_WARN_MB,
  SWAP_WARN_PERCENT,
  SWAP_FAIL_PERCENT,
} from './doctor.ts';
export type { Check, CheckLevel, DoctorContext, DirSize } from './doctor.ts';
export { downAll, measureAll } from './topLevel.ts';
export { assessSwap, swapGate, SWAP_FAIL_FIX, SWAP_WARN_FIX } from './swap.ts';
export type { SwapAssessment, SwapLevel } from './swap.ts';
export { bytesToMb, sizeText } from './dirSize.ts';
export {
  readEffectiveHardware,
  parseRamIncreaseMb,
  parseRamIncreaseLine,
  ramIncreaseFromLog,
  ramIncreaseLineFromLog,
} from './android/hardwareQemu.ts';
export type { EffectiveHardware } from './android/hardwareQemu.ts';
export { classifyLauncher, parseQemuProcesses, listQemuProcesses, processCommandLine, launcherFor, launcherText } from './android/launcher.ts';
export type { Launcher, QemuProcess } from './android/launcher.ts';
export type { TopDownOutcome, AnyMeasurement } from './topLevel.ts';
