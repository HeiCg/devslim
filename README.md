# devslim

devslim makes the Android emulator and the iOS simulator lighter on an Apple
Silicon Mac. On Android it rewrites the AVD `config.ini`, launches the emulator
with lean flags and disables bloat packages in the guest, saving an already
slimmed snapshot. On iOS it marks `com.apple.*` launchd labels as disabled in
each simulator's override store before booting. Every change keeps the previous
state and has a command to undo it.

It is a TypeScript library with a thin CLI on top. It runs directly on Node 25
with type stripping, with no build step and no npm dependencies.

## Without vs with devslim

Same Apple Silicon Mac, 2026-11-17, 2 min idle after boot, no app open, one
measurement per row. Details and caveats in "Measured numbers".

Android, API 35 arm64, pixel_7, memory of the qemu process on the host
(`phys_footprint`):

| how it was started | guest RAM | host memory | guest processes |
|---|---|---|---|
| without devslim (`google_apis`, headless) | 2560 MB | 5525 MB | 341 |
| `devslim android up` | 2560 MB | 4590 MB (-17%) | 325 |
| `devslim android up --aggressive` | 1536 MB | 3444 MB (-38%) | 290 |
| `--aggressive` on an `aosp_atd` image | 1536 MB | 2502 MB (-55%) | 307 |

iOS, iPhone 17, iOS 26.4, sum of the simulator process tree:

| how it was started | processes | memory |
|---|---|---|
| without devslim (`xcrun simctl boot`) | 279 | 4629 MB |
| `devslim ios up` | 67 | 953 MB (-79%) |

## Installation

Requires Node 25 or newer. There is no `npm install` to run.

```
git clone https://github.com/HeiCg/devslim.git
cd devslim
npm link                     # puts `devslim` on the PATH
# or, without npm:
alias devslim="$PWD/bin/devslim"
devslim doctor
```

To use it as a library in another project, run `npm link devslim` in that
project. Node resolves the symlink to the real path, outside `node_modules`, so
it accepts the `.ts` files.

## Top-level commands

```
devslim status [--json]          what is booted, applied profile, drift, session and swap
devslim doctor [--json]          environment checks; exit 1 on any fail
devslim down [--force] [--json]  shuts down everything the session started, Android and iOS
devslim prune [--json]           only cleans records: drops session entries for devices no longer running
devslim measure [--json]         measures every running emulator and simulator
```

`down` shuts down the live devices the session registered. `prune` shuts
nothing down: it only cleans dead records.

`status` and `doctor` only read. Neither calls `adb`, because that would start
the daemon. A running emulator is detected by a `*.lock` directory inside the
`.avd` or by `pgrep -f "qemu-system.*-avd <name>( |$)"`. Who launched each
emulator comes from the qemu command line (`pgrep -fl qemu-system`, or `ps -o
command= -p <pid>`): `devslim` when the devslim session registers the AVD or the
line has `-memory` and `-cores` without `-netfast`; `argent` when it has
`-netfast` and `-crash-report-mode never`; `other` otherwise. devslim puts no
marker in the guest.

`status --json` always returns `{ios, android, session, swap, at}`.

- `ios` lists the booted simulators and every simulator with devslim state. For
  those it counts how many labels of the saved profile are disabled in the store
  and sets `drift: true` when the store lost entries, which happens after a
  `simctl erase`. The fix is to run `devslim ios up` again.
- `android` lists the AVDs with state, with the tune RAM and gpu, whether there
  is a `slim_base` snapshot and whether it is running (by lock, by pgrep, or
  both). When the `hardware-qemu.ini` of the last boot exists, it also shows what
  the emulator actually used: `ramRequestedMb` (the `-memory` of the last `up` or
  `bake`, saved as `lastLaunch` in the state; old state without the field uses
  the tune one), `ramEffectiveMb`, `ramFloored` (effective above requested) and
  `gpuEffective`. `ramMb` and `gpu` keep the requested values. In text: `ram
  requested 2048 MB, effective 2560 MB (emulator raised it)`. An `up --ram 4096`
  without `tune` that ran with 4096 MB does not show as raised. An AVD with state
  whose directory is gone shows as `AVD not found (<dir>); orphan state: devslim
  android forget <avd>`; a simulator with state that no longer exists in
  `simctl` shows with state `missing` and the suffix `simulator no longer
  exists; orphan state: devslim ios forget <udid>`. It also lists every running
  emulator of an AVD without state, with `hasState: false` (text `no devslim
  state`), pid and whatever the `hardware-qemu.ini` has. For a running AVD,
  `launcher` says who launched it (`devslim`, `argent`, `other`; `null` when
  stopped or with no readable line) and the text gets the suffix `launched by
  argent` or `launched outside devslim` when it was not devslim. For a running
  AVD, `advertised` says whether it has an entry in `avd/running/pid_<pid>.ini`
  with `grpc.port` and `grpc.token` (see "Working with argent") and `grpcPort`
  holds the entry's port; when stopped, both are `null`. An entry whose pid has
  already died does not count. Running without an advertisement, the text gets
  the suffix ` no gRPC advertisement`. The token value is never read out, only
  whether it exists.
- `session` lists what devslim started. An entry whose device no longer runs
  comes with `stale: true`. `idleDown` holds `{ms, watcherPid, watcherAlive}`
  when the device was started with `--idle-down` (see "Idle-down") and `null`
  without it; in text, `idle-down after 30m with no app in use (watcher pid N
  alive)` or `DEAD`.
- `swap` holds `usedMb`, `totalMb` and `percent`, read from `sysctl
  vm.swapusage`. With no swap file yet, macOS answers `total = 0.00M  used =
  0.00M`: that is a valid reading, `percent` 0 and text `swap: 0 MB in use (no
  swap file)`. `swap: not read` (fields `null`) only when the command fails or
  the output does not parse.

`doctor` returns a list of `{id, level, message, fix?}` with `level` in `ok`,
`warn` or `fail`. Checks, in this order:

| id | what it looks at |
|---|---|
| `node` | version 25 or newer, otherwise fail |
| `xcode` | `xcodebuild -version` and an iOS 18.5 or newer runtime; no Xcode is warn, broken simctl is fail |
| `android-sdk` | SDK found with `emulator`, `adb` and `avdmanager`; missing SDK is warn, missing binary is fail |
| `emulator-version` | `Pkg.Revision` below 37.2.13 is warn, a version without the host GLES memory leak fix |
| `avd-gpu` | `hw.gpu.mode` of the last boot's `hardware-qemu.ini` in lavapipe, swiftshader, software or guest |
| `avd-ram` | last boot RAM above the request or above 3072 MB. Request = `-memory` of the last `up`/`bake` (`lastLaunch` in the state); without the field, the `hw.ramSize` of `config.ini`. When the emulator raised it, the fix is `tune <avd> --lowram` |
| `profile-drift` | AVD with devslim state whose `config.ini` differs from what the saved profile would produce; warn lists each key as `key: current=X expected=Y` |
| `avd-image` | system image tag (`tag.id`, else `image.sysdir.1`) of each AVD with state vs capabilities that depend on Google services (`push`, `weblogin`, `store`). `google_apis` or playstore with none of them: ok line with the ATD suggestion and the measured number. ATD or `default` with any of them: warn. Missing AVD, unreadable `config.ini` or no tag: skipped |
| `running-off-profile` | emulator running now with a software GPU, or a tuned AVD launched by something other than devslim; fix in two lines (start with `devslim android up` or `ARGENT_EMULATOR_GPU_MODE=host`) |
| `emulator-advertised` | emulator running without a live entry with `grpc.port` and `grpc.token` in `avd/running/`; argent does not see it for screenshot and tap. Entries of a dead pid become an ok line with the count |
| `argent-gpu` | argent on the PATH without `ARGENT_EMULATOR_GPU_MODE=host` |
| `default-boot-snapshot` | AVD with `snapshots/default_boot/ram.bin`, with the size |
| `orphan-images` | system image that no `config.ini` uses, with the size; never deletes |
| `swap` | above 80% is warn, above 95% is fail (same limits and same message as the `up` refusal); no swap file (total 0) is ok with 0 MB in use |
| `ios-always-enabled` | simulator store that disables assistantd, gamed or sharingd |
| `stale-session` | dead entries in the session; and, for a running device with idle-down, a watcher whose pid died (fix: `devslim <platform> up <id> --idle-down <dur>` or `devslim down`) |
| `orphan-state` | devslim state whose AVD (`.avd` directory) or simulator (UDID missing from `simctl list devices`) no longer exists: one warn per file, with the path and the fix `devslim android forget <avd>` or `devslim ios forget <udid>`. Without `simctl`, iOS states show as unverified. Read-only |

`avd-image` only reads. The lighter image note shows as ok (it does not count
as warn nor change the exit) and carries the fix `devslim android create
<avd>-atd --image aosp_atd`, with `--api N` when the current image is not API
35. The ATD warn with `push`, `weblogin` or `store` says the capability does not
work on that image (on `google_atd`, which has reduced Google services, it says
it may not work) and suggests `create <avd>-gapis --image google_apis`.

`profile-drift` compares, for each AVD in `$DEVSLIM_HOME/state/android/`, the
current `config.ini` with what `tune` would write from the saved profile (the
same keys and values as `plan`). Read-only. The fix is `devslim android tune
<avd>`, which goes back to the saved profile. When turning a capability on or
off explains the drift, the fix first suggests `--need` with the full list: for
example `hw.gps=yes` with a profile without `location` suggests `devslim android
tune <avd> --need camera,location` if the profile already had `camera`. An AVD
with state that no longer exists or with an unreadable `config.ini` is skipped
and counted in the ok line.

`down` removes dead entries from the session without sending any command to the
device and delegates the rest to `android down` and `ios down`. With `--force`
it also shuts down what devslim did not start. If a platform's tooling is
missing (no Android SDK, no Xcode) and nothing of it is alive in the session,
`down --force` skips that platform, warns on stderr (`devslim: warning: down
--force skipped android: <reason>`) and returns an entry `result: "skipped"`
with the reason in `detail` (and empty `name` and `id`) in the `--json` array.
Skipping is not a failure: the exit stays 0 if the rest succeeded.

`prune` drops from the session only the entries whose device no longer runs,
using the same detection as the `STALE` of `status` (Android with no lock and
no qemu; simulator shut down or gone), together with their idle-down record. It
does not shut down any device, does not signal the watcher (it exits on its own
when it sees the entry gone) and does not delete state. It prints one line
`removed from session: <platform> <name> <id> (<reason>)` per entry, or
`nothing to clean up`; with `--json`, `{removed: [...]}`.

Every write to `session.json` (`up`, `down`, `prune`, `forget` and the idle-down
watcher, which are separate processes) goes through an advisory lock:
`session.json.lock`, created with `wx` and holding the owner pid and the time.
A newcomer waits in 50 ms steps up to 5 s. A lock older than 30 s or with a dead
pid is treated as abandoned and removed. Past 5 s, the command stops with an
error naming the file and the owner pid. The write is still atomic (temporary
file and rename).

`measure --json` returns an array with the same objects
as `android measure` and `ios measure`; with nothing running, it returns `[]` and exits 0.

On Android, `host` holds three numbers for the qemu process, any of which can be
`null`: `footprintMb` (the `phys_footprint:` line of `footprint -p`),
`footprintHeaderMb` (the `Footprint: N MB` of the same command's header) and
`rssMb` (`ps -o rss=`). The two footprints diverge for a process that uses
Hypervisor.framework, such as qemu, so a before/after comparison must always use
the same field. The text shows all three.

## Android workflow

```
devslim android create slim-api35        # new AVD (google_apis); applies tune with a 720x1600@320 screen, does not boot
devslim android create ui-api35 --image aosp_atd   # or: ATD image, lighter, for UI and logic tests
devslim android tune slim-api35          # or: tune an existing AVD (backs up config.ini first)
devslim android bake slim-api35          # once: boots, slims down via adb, saves slim_base, shuts down
devslim android up slim-api35            # day to day: boots from slim_base with lean flags
devslim android up slim-api35 --idle-down 30m   # or: shuts down on its own after 30 min with no app in use
devslim down                             # shuts down what was started
devslim android up slim-api35            # restore needs the AVD running if it was baked
devslim android restore slim-api35       # re-enables packages, restores settings and config.ini byte for byte
devslim android forget old-api35         # AVD deleted elsewhere: deletes only the leftover state
```

`tune` writes RAM (default 2048 MB; see the emulator floor below), heap, 2
cores, `hw.gpu.mode=host`, sensors, GPS and cameras off, and deletes `hardware-qemu.ini` and `snapshots/`, which the
emulator regenerates. `plan` and `tune` show the size of `snapshots/` on the
`tune would delete`/`removed` line (and `snapshotsMb` in the JSON). `plan`,
`tune`, `up` and `bake` start from the profile saved by the last `tune`; flags
given on the command line override only what they say. So `tune --screen
720x1600@320` after `tune --need location --ram 3072` keeps RAM and `location`
and changes only `hw.lcd.*`. `--need a,b` and `--for <dir>` replace the saved
capability list (they do not merge); `--need none` clears it. `--reset` (only
`plan` and `tune`) ignores the saved profile and starts from the defaults. When
inheriting, `plan` and `tune` show the line `profile inherited from the previous
tune` (`inheritedProfile` in the JSON). The `config.ini` backup in the state is
still the one from the first tune. The emulator starts with `-gpu host -memory N
-cores 2 -port N -grpc G -grpc-use-token -no-window -no-audio -camera-back none
-camera-front none -feature -Vulkan -no-boot-anim -no-metrics`, with `G = 8554 +
(N - 5554)`, and `-lowram` before `-no-boot-anim` when the profile has lowram.
Without `--port`, `plan` shows the line with `-grpc 8554` and the suffix `(gRPC
8554 for reference; port chosen at up)`, because `up` picks a free port at
launch.

RAM floor. The emulator silently raises any `-memory` below its floor, unless
`-lowram` is on (see "Measured numbers"). Floors seen so far: 2560 MB on a
pixel_7 phone and 4096 MB on a 2560x1600 tablet; these are two observations, not
a rule. A smaller screen does not lower the floor: with 720x1600@320 the
emulator stayed at 2560 MB. `--ram 1536` without lowram also became 2560 MB.
With lowram the request sticks (`--aggressive`, 1536 MB with lowram, stayed at
1536 MB), but the guest then reports itself as a low-RAM device, which changes
app behavior.

After boot, `up` reads `hardware-qemu.ini` (or, without it, the line
`Increasing RAM size to N MB` from this boot's log), returns `ramEffectiveMb`
and, if the effective value exceeded the requested one, warns on stderr with
both values, the label `(emulator raised it)`, this boot's log line when it
exists, and the way out: `devslim android tune <avd> --lowram` with the AVD shut
down, with the warning that lowram changes app behavior. If the profile already
had lowram, the warning says `emulator raised it even with lowram` and suggests
nothing.

`plan` and `tune` print a `note:` line (`ramNote` field in the JSON, `null`
without a note) when the profile requests less than 2560 MB without lowram: the
emulator will likely raise the request, with the two observed floors, and
`--lowram` makes the request stick. If this AVD's last boot (the
`hardware-qemu.ini`, read before `tune` deletes it) shows that the emulator
raised the request, the note cites that value instead of the generic floors and
goes away when the new request already exceeds it. The request compared is the
`-memory` of the last `up`/`bake` (`lastLaunch: {ramMb, lowRam, at}` in the
state, which they write on every launch), not the profile one: `up --ram 4096`
without `tune` does not count as a raise. Old state without the field uses the
tune profile. A `tune` that rewrites `config.ini` (and deletes
`hardware-qemu.ini`) discards `lastLaunch`; a `tune` with no change keeps it.
An AVD without state does not get state on `up`.

If the AVD is already running, `up` does not start another one and returns the
existing one, with `launcher` and `gpuEffective`. When the launcher was not
devslim or the effective GPU is software, it warns on stderr with the facts and
the way out: `devslim android down <avd> --force` and start it again. It never
shuts it down on its own.

When `up` starts without `slim_base`, the last line suggests `devslim android
bake <avd>` (`hint` field in `--json`). Starting from the snapshot, there is no
hint.

Swap: `up`, `bake` and `ios up` refuse to boot with swap above 95%, with the
same message as `doctor`; `--force` boots anyway. Between 80% and 95% they only
warn. A device that was already running is never blocked by swap.

Profile flags: `--ram N` (1536 to 8192), `--aggressive` (1536 MB and `-lowram`),
`--lowram`, `--no-lowram`, `--gpu M`, `--vulkan`, `--screen keep|WxH@dpi`,
`--port N`, `--need a,b`, `--for <dir>`, `--no-grpc` and `--grpc`. `--lowram`,
`--no-lowram`, `--no-grpc` and `--grpc` also apply to `bake`. `devslim android
plan <avd>` shows the `config.ini` diff and the emulator command line without
writing anything.

`--lowram` turns on `-lowram` without changing RAM; `tune` saves `lowRam: true`
in the profile and later commands inherit it. `--no-lowram` drops the saved
lowram or the one from `--aggressive` (`--aggressive --no-lowram` = 1536 MB
without lowram). Both together are a usage error. `--aggressive` is still 1536
MB plus lowram in `plan`, `tune` and `up`; in `bake` it is only the bloat list
level.

`create` accepts in `--image` the full id
(`system-images;android-35;google_apis;arm64-v8a`) or a shortcut: `google_apis` (default), `google_atd`, `aosp_atd` or `default`,
expanded to `system-images;android-<api>;<tag>;<abi>`. `--api N` picks the
shortcut's API (default 35) and does not combine with a full id. The ABI follows
the host: `arm64-v8a` on Apple Silicon, `x86_64` elsewhere. Before calling
`avdmanager`, `create` checks that the image exists in
`<sdk>/system-images/android-<api>/<tag>/<abi>`; if it does not, it stops with
the exact command `sdkmanager "<id>"`. devslim never downloads an image on its
own.

Which image to use. ATD images have no Google services (`aosp_atd`) or reduced
services (`google_atd`); `default` is plain AOSP. They are lighter (see
"Measured numbers"), but `aosp_atd` has no Google sign-in, FCM push or Play
Billing purchases. Use ATD for UI and logic tests, and `google_apis` when the
test needs sign-in, push or purchases. `doctor` (`avd-image`) points out both
mismatches.

`forget <avd>` deletes the state of an AVD that no longer exists (`status` and
`doctor` point it out) and its session entry, if any, without any command to the
emulator. With the AVD still on disk it refuses and tells you to use `restore`,
which undoes the tune; `--force` deletes the record anyway and warns that the
AVD was not touched. With no state and no session entry, it is an error.

`bake` disables packages from the managed list that exist in the image
(`--aggressive` includes the Play Store, setup wizards and Gboard), zeroes
animation scales, turns off `auto_sync` and the stylus screen, runs dexopt and
`am kill-all`, and saves the snapshot.
It never disables Bluetooth or Chrome. The state lives in
`~/.devslim/state/android/<avd>.json`.

## iOS workflow

```
devslim ios plan QA-iPhone17             # read-only: what up would disable and what it would repair
devslim ios up QA-iPhone17               # writes the store with the device shut down, boots and verifies
devslim ios up QA-iPhone17 --idle-down 30m   # or: shuts down on its own after 30 min with no app in use
devslim ios off QA-iPhone17              # returns each label to its saved value
devslim ios forget 71DA7575-...          # simulator deleted elsewhere: deletes only the leftover state
```

Accepts a UDID or an exact name. The default profile disables the 173 managed
labels, in 16 categories (`devslim ios categories`). It breaks remote push,
StoreKit, universal links and Apple ID sign-in; re-enable what the app uses with
`--need`. `--except cat,cat` keeps whole categories and `--keep label` keeps
individual labels.

The simulator enters the session whenever `up` booted it: from scratch or in a
reboot to apply the profile to a simulator that was already booted outside the
profile. So `ios down` (without `--force`) and `--idle-down` work in both cases.
If it was already in the session, the entry stays as it was. A simulator that is
already booted and already slim is not rebooted and does not enter the session;
with `--idle-down`, the warning says `simulator was already booted and slim;
devslim did not start it`.

`ios forget <udid|name>` deletes the state of a simulator that no longer exists
(by UDID or by the name saved in the state) and its session entry. A simulator
that still exists is refused (the right command is `ios off`); `--force`
deletes the record anyway. If `simctl` fails, it cannot check and it also
refuses without `--force`. It never sends a command to the simulator.

`up` saves in `~/.devslim/state/ios/<UDID>.json` the previous value of each label
it changes, and the first backup wins. After boot it verifies with `launchctl
print-disabled`. If some label did not stick, it falls back to `launchctl
disable/enable` per label and reboots; whatever is still missing goes in the list
and the exit code is 3.

`com.apple.assistantd`, `com.apple.gamed` and `com.apple.sharingd` always stay
enabled. If a device's store already has them disabled (inherited from another
tool), `up` writes all three as enabled, saves the old value and verifies after
boot. `off` restores the saved value. `--keep` and `--except` do not reach this
repair. `plan` shows what would be repaired in `repair`.

## Capabilities

| capability | iOS | Android | when |
|---|---|---|---|
| `audio` | nothing | `hw.audioOutput`, without `-no-audio` | app with sound |
| `camera` | `photos` category | emulated cameras | app with camera or gallery |
| `keyboard` | nothing | `bake --aggressive` keeps Gboard (`com.google.android.inputmethod.latin`) | testing layouts that move around the on-screen keyboard |
| `location` | `com.apple.MapKit.SnapshotService` | `hw.gps=yes`; `bake` keeps Google Maps (`com.google.android.apps.maps`) | app with map or location |
| `push` | `com.apple.apsd` | nothing | expo-notifications |
| `store` | `store` and `icloud` categories | separate AVD with Play Store | only when testing purchases |
| `weblogin` | `web` category | nothing, Chrome is never disabled | google-signin, universal links |
| `window` | opens Simulator.app | without `-no-window` | manual use |

`--for <dir>` reads the app's `package.json` and derives `audio`, `camera`,
`location`, `push` and `weblogin`. `location` comes from `expo-location`,
`react-native-geolocation-service`, `@react-native-community/geolocation`,
`@rnmapbox/maps` or `react-native-maps`. `store`, `window` and `keyboard` only
come in through `--need`.

Gboard is only on the `--aggressive` list, never on the default one. Without it,
text still arrives via `adb shell input` or argent's input, but you cannot test
layouts that move around the on-screen keyboard; for that use `--need
keyboard`. A `bake` with `keyboard` re-enables a Gboard disabled by a previous
`bake`, and `restore` re-enables it like any package on the list. An image that
has no Gboard just skips the package, like any other on the list.

On iOS, CoreLocation (`com.apple.locationd`) and GeoServices (`com.apple.geod`,
MapKit tiles and geocoding) are not on the managed list and are never disabled,
with or without `location`. From the list, `location` only re-enables the MapKit
snapshot XPC. On Android, slimming via adb never touches location settings.
Without `location`, `bake` disables Google Maps along with the other media apps;
with `location`, it stays enabled at both levels (default and `--aggressive`),
the same way `camera` keeps `com.android.camera2`. A `bake` with `location`
re-enables Maps disabled by a previous `bake`.

## Working with argent

Fact measured on 2026-11-16: argent launched `qa-tablet-api35` on its own with
`-avd qa-tablet-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio
-no-boot-anim -netfast -no-metrics -crash-report-mode never`. The AVD's
`config.ini` had `hw.gpu.mode=host`, but the command line `-gpu auto` won: that
boot's `hardware-qemu.ini` came out with `hw.gpu.mode = lavapipe` (software
rendering) and `hw.ramSize = 4096`. Tuning `config.ini` does not protect against
this; the command line decides.

Correct order:

1. Start the device with `devslim android up <avd>`.
2. Open argent afterwards. Confirmed: it reuses the devslim emulator in the
   tools that use adb (`reinstall-app`, `launch-app`) and in screenshot. The
   screen tools (screenshot, describe, tap) depend on the gRPC advertisement
   described below.
3. Never ask argent for a forced boot of an AVD that devslim manages: it
   relaunches with `-gpu auto` and without `-memory`.

gRPC advertisement. argent (simulator-server) discovers the emulator through the
file `avd/running/pid_<pid>.ini` (on macOS in
`~/Library/Caches/TemporaryItems/avd/running/`, on Linux in
`$XDG_RUNTIME_DIR/avd/running/`) and requires `grpc.port` and `grpc.token` in
it. Measured: an emulator launched with `-port` and without `-grpc` neither
writes that file nor starts the gRPC server, with or without a window, and
`-grpc-use-token` alone does not fix it. That is why devslim always launches
with `-grpc <port> -grpc-use-token`. The gRPC port is per instance: `8554 +
(console port - 5554)`, that is 8554 for `emulator-5554`, 8556 for
`emulator-5556`. Validated on 2026-11-16 with `qa-tablet-api35` on `-port 5554
-grpc 8554`: the `pid_<pid>.ini` came out with `grpc.port=8554` and
`grpc.token`, and `argent run screenshot --udid emulator-5554` worked. Tap and
describe have not been checked one by one yet.

After boot, `up` looks for the AVD's entry (by `avd.name` and `port.serial`) for
up to 10 s and returns `advertised` and `grpcPort`. Without an entry with port
and token, it warns on stderr that tools that rely on gRPC will not see the
emulator; adb works normally and the exit stays 0. `status` and `doctor`
(`emulator-advertised`) show the same. A `pid_<pid>.ini` can be left over from
an emulator that died without cleaning up (crash, kill -9). That is why an entry
only counts when the pid in the file name still exists (`kill -0`; no
permission counts as alive). A dead pid entry does not count as an
advertisement in `up`, `status` or `doctor`, which only reports how many it
ignored. devslim never deletes these files: they belong to the emulator.
`--no-grpc` in `plan`, `tune`, `up` and `bake` launches without both flags and
does not warn; `tune` saves `grpc: false` in the profile. `--grpc` in the same
commands turns it back on over the saved profile (`tune --grpc` saves `grpc:
true` again); with neither, whatever tune saved applies. Both together are a
usage error. State saved before this field counts as on.

Alternative when argent needs to boot on its own: export
`ARGENT_EMULATOR_GPU_MODE=host` in its tool-server environment. `doctor` warns
when it is missing (`argent-gpu`) and when an emulator already runs outside the
profile (`running-off-profile`). `status` shows `launched by argent` and `up`
warns if it finds the AVD running that way.

- The devslim snapshot is called `slim_base`. `default_boot` belongs to the
  emulator and to argent, and devslim never writes to it.
- devslim launches with `-feature -Vulkan`, like argent, so that argent's
  snapshot probe does not refuse and rewrite `ram.bin`.

## Idle-down

A forgotten device costs 1 to 5 GB of RAM. With `--idle-down <dur>`, `up`
leaves a detached process that shuts the device down when nobody uses it:

```
devslim android up slim-api35 --idle-down 30m
devslim ios up QA-iPhone17 --idle-down 1h
```

`<dur>` accepts `30m`, `90s`, `1h` or a bare number, read as minutes. The
minimum is 2 minutes; below that, or in another format, it is a usage error
before booting. It only applies to `android up` and `ios up`, is never saved in
the `tune` profile and, without the flag, nothing changes.

`up` prints a line `idle-down: after <dur> with no app in use (watcher pid <n>,
log <path>)` and, with `--json`, gets `idleDown: {ms, watcherPid, startedAt,
logFile}`. The watcher is the process `node bin/devslim _idle-watch <platform>
<id> --idle-ms <n>` (internal subcommand, not in `--help`), with stdout and
stderr in `$DEVSLIM_HOME/logs/idle-<id>.log`; `<id>` is the AVD name on Android
and the UDID on iOS. The session keeps `idleDown: {ms, watcherPid, startedAt}`
in the device entry. A second `up --idle-down` of the same device ends the
previous watcher and starts another with the new duration.

Idle means no third-party app in use. Every 30 s the watcher looks at:

- Android: the `topResumedActivity=` line (or `ResumedActivity:`, the per-display
  spelling and that of older versions) of `adb -s <serial> shell dumpsys activity
  activities`. A package starting with `com.android.`, `com.google.android.` or
  `android` (launcher, Settings, system apps) does not count as use, nor does
  empty or unreadable output while the device answers adb. Any other package in
  the foreground counts.
- iOS: `xcrun simctl spawn <udid> launchctl list`. A
  `UIKitApplication:<bundle>` entry with a bundle outside `com.apple.` counts as
  use.

Use seen resets the clock. After the whole duration idle, the watcher checks the
session again and shuts down by the same path as `devslim android down <avd>`
or `devslim ios down <udid>` (the entry leaves the session the same way),
writes a log line with the time, device and how long it was idle, and exits.

The watcher exits without shutting anything down when:

- the device is no longer running (serial missing from `adb devices`, simulator
  not `Booted`);
- the device entry is gone from the session or belongs to another boot (pid or
  `startedAt` different from when the watcher started);
- the entry's `idleDown` record no longer has its pid (a `down` or a new
  `up --idle-down` removed it);
- polling fails 3 times in a row (each failure goes to the log).

It never shuts down a device that devslim did not start: with no session entry,
`up --idle-down` only warns on stderr (`idle-down ignored`) and does not launch
a watcher. On iOS, an `up` that reboots the simulator to apply the profile counts
as a devslim boot; only a simulator that was already booted and slim is left out.
`devslim down`, `devslim android down` and `devslim ios down` send SIGTERM to the
registered watcher before shutting the device down and clear the field, even
when the shutdown fails. Before the signal, `down` checks with `ps -o command=
-p <pid>` that the pid is still this device's watcher; a dead or reused pid only
gets the field cleared.

`status` shows `idle-down after <dur>` on the session line and whether the
watcher pid is alive. `doctor` (`stale-session`) warns when the watcher died with
the device still running: the device will no longer shut down on its own, and
the reason is in the log `idle-<id>.log`.

Limit: the criterion is a third-party app in the foreground, not activity in
general. A device used only through adb or argent with no third-party app open
(for example sitting on the home screen during a long build, before the
`install`) counts as idle and shuts down when the duration runs out. Pick a
duration longer than the build, or start without `--idle-down`.

## Using as a library

`src/index.ts` exports everything the CLI uses. Every process goes through an
injectable `Exec`, and the tests use `createFakeExec`, `createFakeAndroid` and
`createFakeIos`.

```ts
import { collectStatus, runDoctor, doctorExitCode } from 'devslim';

const status = await collectStatus();
if ((status.swap.percent ?? 0) > 80) console.warn('swap is high, do not start a device');
const checks = await runDoctor();
process.exitCode = doctorExitCode(checks);
```

```ts
import { buildAndroidProfile, upAvd, measureAvd } from 'devslim';

const up = await upAvd('slim-api35', buildAndroidProfile({ ramMb: 2048, port: 5556 }));
const m = await measureAvd('slim-api35');
console.log(up.serial, m.host.footprintMb);
```

## Known limits

- One device at a time. `up` and `bake` refuse if an emulator or simulator is
  already running, or if swap exceeds 95%, unless `--force`.
- iOS 18.5 and later only. Before that, launchd_sim does not keep the overrides
  across boots. tvOS, watchOS and visionOS are out.
- `disabled.plist` is a CoreSimulator internal detail. That is why `up` always
  verifies after boot and `status` reports drift.
- Not yet verified whether the periodic macOS cleanup reaches
  `/private/var/tmp`.
- `down` only knows what is registered in the session, unless `--force`.
- Idle-down only sees a third-party app in the foreground: a device sitting on
  the home screen during a long build counts as idle (see "Idle-down").
- The Android package list came from avdslim and `bake` checks each one against
  `pm list packages` before disabling it. A different image may have names the
  list does not cover.
- No GUI, CI, physical device, device cloning or disk cleanup. `doctor` reports
  orphan images and large snapshots, but does not delete them.

## Measured numbers

Measured on 2026-11-17 on an Apple Silicon Mac, one measurement per row, 2 min
idle after boot, no app open.

Android, API 35 arm64, pixel_7:

| profile | effective RAM | qemu phys_footprint on the host | guest processes |
|---|---|---|---|
| `google_apis` without devslim, headless, `-gpu auto` (fell back to lavapipe) | 2560 MB | 5525 MB | 341 |
| devslim default (requests 2048), original screen | 2560 MB | 4590 MB | 325 |
| devslim default, 720x1600@320 screen | 2560 MB | 4343 MB | 313 |
| devslim `--ram 1536`, without lowram | 2560 MB (raised) | 4469 MB | 311 |
| devslim `--aggressive` (1536 and `-lowram`) | 1536 MB | 3444 MB | 290 |
| devslim default on an `aosp_atd` image | 2560 MB | 3660 MB | 262 |
| devslim default on a `google_atd` image | 2560 MB | 4687 MB | 277 |
| devslim default on an `aosp_atd` API 30 image | 2048 MB | 2398 MB | 223 |
| devslim `--aggressive` on an `aosp_atd` API 35 image | 1536 MB | 2502 MB | 307 |

What the rows show:

- The emulator raises any `-memory` below its floor (2560 MB on this phone;
  4096 MB seen on a 2560x1600 tablet), unless `-lowram` is on. `--ram 2048` and
  `--ram 1536` on their own do not stick.
- A smaller screen does not lower the floor: effective RAM stayed at 2560 MB.
- An image without Google services saves roughly the same as lowram.
- `google_atd` (reduced Google services) did not pay off on the host: it stayed
  in the range of the slimmed `google_apis`, although the guest used less RAM
  (760 MB).
- `aosp_atd` API 30 was the lightest row: the emulator honored 2048 MB without
  lowram (the 2560 MB floor is API 35's) and the host stayed at 2398 MB. It
  works for UI and logic tests when the app's `minSdk` allows API 30; it does
  not validate Android 15 behavior.
- On API 35, `aosp_atd` with `--aggressive` came close to that (2502 MB), with
  tight guest RAM (744 MB available). It is the lightest option that still runs
  Android 15.
- In the guest, Google Play Services used 391 MB of PSS and Gboard
  (`com.google.android.inputmethod.latin`) 81 MB.

iOS, iPhone 17, iOS 26.4:

| profile | processes | memory |
|---|---|---|
| without devslim | 279 | 4629 MB |
| devslim default (boot 3.4 s) | 67 | 953 MB |

Direct comparison with simslim 0.11.0 (Homebrew), iPhone 17, iOS 26.4, a fresh
simulator for each tool, two alternating rounds, 2 min idle:

| tool | 1st boot | 2nd boot | labels disabled in system |
|---|---|---|---|
| simslim, round 1 | 92 proc, 2867 MB | 71 proc, 2800 MB | 171 |
| devslim, round 1 | 76 proc, 1206 MB | 65 proc, 976 MB | 174 |
| simslim, round 2 | 90 proc, 2447 MB | 70 proc, 2659 MB | 171 |
| devslim, round 2 | 76 proc, 1114 MB | 64 proc, 967 MB | 174 |

The difference comes almost entirely from Spotlight: 1533 MB in the simslim
simulator versus 68 MB in the devslim one; the rest of the process list is
similar. devslim disables 5 labels that simslim 0.11.0 leaves enabled
(`ClipServices.clipserviced`, `RemoteManagementAgent`,
`accessibility.axassetsd`, `managedassetsd`, `remotemanagementd`). Which of them
holds Spotlight up has not been isolated.

Other measurements from the same day, devslim, 2 min idle:

- iOS 18.6, iPhone 16: 248 processes and 4705 MB without devslim; 71 and 1136
  MB with it. The older version does not gain more than 26.4.
- iPhone 17, 17e and SE 3 on 26.4 landed between 1082 and 1192 MB on first
  boot: screen size does not change the result.
- The first boot of a fresh simulator costs about 150 MB and about 13 s more
  than the following ones.
- Disabling extra daemons in the `user/foreground` domain does not work: 11 of
  13 came back after the reboot.

Caveats:

- One measurement per row, no app open.
- The Android baseline ran headless. The iOS baseline was the first boot of a
  freshly created simulator.
- `footprint` reports two numbers for qemu: the header and `phys_footprint`.
  The tables use `phys_footprint`, which for this process diverges from the
  header; compare the rows with each other instead of reading the absolute
  values.

Real use on iOS (2026-11-17, slim profile, iOS 26.4, iPhone 17 and iPad Pro 13,
release simulator build with an embedded bundle): boot in about 6.6 s; app
install, sign-in, map, search, route and API calls worked. Side effect seen: a
"Poor Internet Connection" alert on first launch, once; after that the network
worked. Not yet checked: an Expo app in a dev build connecting to Metro.

Earlier measurement, under other conditions (2026-11-16, bench-api35, pixel_7
1080x2400, API 35 google_apis, tuned, no bake, map app open, ~30 min of use):
phys_footprint 5582 MB, footprint header 3000 MB, RSS 4034 MB, guest MemTotal
2473 MB, 288 processes in the guest; the emulator raised RAM from 2048 to 2560
MB.

## Tests

```
node --test --test-concurrency=2
```

The tests use AVDs, SDK and iOS store in a temporary directory, with fake exec,
spawn, clock and sleep. None of them calls the real adb, emulator, avdmanager or
simctl, nor writes to `~/.android` or `/private/var/tmp`.

## License

MIT. See `LICENSE`.

## Third-party licenses

The Android package list derives from avdslim (MIT). iOS labels and categories
derive from simslim (MIT). See `NOTICE`.
