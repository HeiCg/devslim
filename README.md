# devslim

devslim deixa o emulador Android e o simulador iOS mais leves num Mac Apple
Silicon. No Android ele reescreve o `config.ini` do AVD, lanca o emulador com
flags economicas e desliga pacotes de bloat no guest, gravando um snapshot ja
enxuto. No iOS ele marca labels launchd `com.apple.*` como desligados no store
de overrides de cada simulador antes de bootar. Toda mudanca guarda o estado
anterior e tem comando para desfazer.

E uma lib TypeScript com uma CLI fina por cima. Roda direto no Node 25 com type
stripping, sem build e sem nenhuma dependencia npm. Spec: `../SPEC-devslim.md`.

## Instalacao

Precisa de Node 25 ou mais novo. Nao ha `npm install` a rodar.

```
cd tools/devslim
npm link                     # poe `devslim` no PATH
# ou, sem npm:
alias devslim="$PWD/bin/devslim"
devslim doctor
```

Para usar como lib em outro projeto, rode `npm link devslim` nesse projeto. O
Node resolve o symlink para o caminho real, fora de `node_modules`, e por isso
aceita os arquivos `.ts`.

## Comandos de topo

```
devslim status [--json]          o que esta bootado, perfil aplicado, drift, sessao e swap
devslim doctor [--json]          checagens de ambiente; exit 1 se alguma der fail
devslim down [--force] [--json]  desliga tudo que a sessao subiu, Android e iOS
devslim measure [--json]         mede todo emulador e simulador rodando
```

`status` e `doctor` so leem. Nenhum dos dois chama `adb`, porque isso subiria o
daemon. Emulador rodando e detectado por diretorio `*.lock` dentro do `.avd` ou
por `pgrep -f "qemu-system.*-avd <nome>( |$)"`. Quem lancou cada emulador sai
da linha de comando do qemu (`pgrep -fl qemu-system`, ou `ps -o command= -p
<pid>`): `devslim` quando a sessao do devslim registra o AVD ou a linha tem
`-memory` e `-cores` sem `-netfast`; `argent` quando tem `-netfast` e
`-crash-report-mode never`; `other` no resto. O devslim nao poe marca no guest.

`status --json` devolve sempre `{ios, android, session, swap, at}`.

- `ios` lista os simuladores bootados e todo simulador com state do devslim. Para
  esses ele conta quantos labels do perfil salvo estao desligados no store e
  marca `drift: true` quando o store perdeu entradas, o que acontece depois de um
  `simctl erase`. A correcao e rodar `devslim ios up` de novo.
- `android` lista os AVDs com state, com RAM e gpu do tune, se ha snapshot
  `slim_base` e se esta rodando (por lock, por pgrep, ou os dois). Quando o
  `hardware-qemu.ini` do ultimo boot existe, traz tambem o que o emulador de
  fato usou: `ramRequestedMb` (o `-memory` do tune), `ramEffectiveMb`,
  `ramFloored` (efetiva acima da pedida) e `gpuEffective`. `ramMb` e `gpu`
  continuam com os valores pedidos. No texto: `ram pedida 2048 MB, efetiva
  2560 MB (emulador elevou)`. Lista tambem todo emulador rodando de AVD sem
  state, com `hasState: false` (texto `sem state do devslim`), pid e o que o
  `hardware-qemu.ini` tiver. Para AVD rodando, `launcher` diz quem o lancou
  (`devslim`, `argent`, `other`; `null` parado ou sem linha legivel) e o texto
  ganha o sufixo `lancado por argent` ou `lancado por fora do devslim` quando
  nao foi o devslim. Para AVD rodando, `advertised` diz se ha entrada dele em
  `avd/running/pid_<pid>.ini` com `grpc.port` e `grpc.token` (ver "Convivencia
  com argent") e `grpcPort` traz a porta da entrada; parado, os dois vem
  `null`. Entrada cujo pid ja morreu nao conta. Rodando sem anuncio, o texto ganha o sufixo ` sem anuncio gRPC`. O
  valor do token nunca e lido para fora, so se ele existe.
- `session` lista o que o devslim subiu. Entrada cujo device nao roda mais vem
  com `stale: true`.
- `swap` traz `usedMb`, `totalMb` e `percent`, lidos de `sysctl vm.swapusage`.

`doctor` devolve uma lista de `{id, level, message, fix?}` com `level` em `ok`,
`warn` ou `fail`. Checagens, nesta ordem:

| id | o que olha |
|---|---|
| `node` | versao 25 ou mais nova, senao fail |
| `xcode` | `xcodebuild -version` e um runtime iOS 18.5 ou mais novo; sem Xcode e warn, simctl quebrado e fail |
| `android-sdk` | SDK localizado com `emulator`, `adb` e `avdmanager`; SDK ausente e warn, binario faltando e fail |
| `emulator-version` | `Pkg.Revision` abaixo de 37.2.13 e warn, versao sem o fix de vazamento de memoria GLES do host |
| `avd-gpu` | `hw.gpu.mode` do `hardware-qemu.ini` do ultimo boot em lavapipe, swiftshader, software ou guest |
| `avd-ram` | RAM do ultimo boot acima do `config.ini` ou acima de 3072 MB |
| `profile-drift` | AVD com state do devslim cujo `config.ini` difere do que o perfil salvo produziria; warn lista cada chave como `chave: atual=X esperado=Y` |
| `running-off-profile` | emulador rodando agora com GPU por software, ou AVD tunado lancado por outro que nao o devslim; fix em duas linhas (subir com `devslim android up` ou `ARGENT_EMULATOR_GPU_MODE=host`) |
| `emulator-advertised` | emulador rodando sem entrada viva com `grpc.port` e `grpc.token` em `avd/running/`; o argent nao o enxerga para screenshot e tap. Entradas de pid morto viram uma linha ok com a contagem |
| `argent-gpu` | argent no PATH sem `ARGENT_EMULATOR_GPU_MODE=host` |
| `default-boot-snapshot` | AVD com `snapshots/default_boot/ram.bin`, com o tamanho |
| `orphan-images` | system image que nenhum `config.ini` usa, com o tamanho; nunca apaga |
| `swap` | acima de 80% e warn, acima de 95% e fail (mesmos limites e mesma mensagem da recusa do `up`) |
| `ios-always-enabled` | store de simulador que desliga assistantd, gamed ou sharingd |
| `stale-session` | entradas mortas na sessao |

`profile-drift` compara, para cada AVD em `$DEVSLIM_HOME/state/android/`, o
`config.ini` atual com o que o `tune` gravaria a partir do perfil salvo (as
mesmas chaves e valores do `plan`). So le. O fix e `devslim android tune
<avd>`, que volta ao perfil salvo. Quando ligar ou desligar uma capacidade
explica o drift, o fix sugere antes o `--need` com a lista completa: por
exemplo `hw.gps=yes` com perfil sem `location` sugere `devslim android tune
<avd> --need camera,location` se o perfil ja tinha `camera`. AVD com state que
nao existe mais ou com `config.ini` ilegivel e pulado e contado na linha ok.

`down` remove da sessao as entradas mortas sem mandar comando nenhum ao device e
delega o resto para `android down` e `ios down`. Com `--force` tambem desliga o
que o devslim nao subiu. Se faltar a ferramenta de uma plataforma (sem SDK
Android, sem Xcode) e nao houver nada vivo dela na sessao, o `down --force` pula
essa plataforma, avisa em stderr (`devslim: aviso: down --force pulou android:
<motivo>`) e devolve uma entrada `result: "skipped"` com o motivo em `detail`
(e `name` e `id` vazios) no array do `--json`. Pular nao e falha: o exit
continua 0 se o resto deu certo. `measure --json` devolve um array com os mesmos objetos
de `android measure` e `ios measure`; sem nada rodando, devolve `[]` e sai com 0.

No Android, `host` traz tres numeros do processo qemu, qualquer um pode ser
`null`: `footprintMb` (linha `phys_footprint:` do `footprint -p`),
`footprintHeaderMb` (o `Footprint: N MB` do cabecalho do mesmo comando) e
`rssMb` (`ps -o rss=`). Os dois footprints divergem em processo que usa
Hypervisor.framework, como o qemu, entao a comparacao antes/depois deve usar
sempre o mesmo campo. O texto mostra os tres.

## Fluxo Android

```
devslim android create slim-api35        # AVD novo; aplica o tune com tela 720x1600@320, nao boota
devslim android tune slim-api35          # ou: tune num AVD existente (backup do config.ini antes)
devslim android bake slim-api35          # uma vez: boota, enxuga via adb, grava slim_base, desliga
devslim android up slim-api35            # dia a dia: sobe do slim_base com flags economicas
devslim down                             # desliga o que subiu
devslim android up slim-api35            # restore precisa do AVD rodando se houve bake
devslim android restore slim-api35       # religa pacotes, devolve settings e o config.ini byte a byte
```

O `tune` grava RAM (padrao 2048 MB), heap, 2 cores, `hw.gpu.mode=host`, sensores,
GPS e cameras desligados, e apaga `hardware-qemu.ini` e `snapshots/`, que o
emulador regenera. `plan` e `tune` mostram o tamanho de `snapshots/` na linha
`apagaria`/`removido` (e `snapshotsMb` no JSON). `plan`, `tune`, `up` e `bake`
partem do perfil gravado pelo ultimo `tune`; flags dadas na linha sobrepoem so
o que dizem. Assim `tune --screen 720x1600@320` depois de `tune --need location
--ram 3072` mantem RAM e `location` e muda so `hw.lcd.*`. `--need a,b` e `--for
<dir>` substituem a lista de capacidades salva (nao unem); `--need none` limpa.
`--reset` (so `plan` e `tune`) ignora o perfil salvo e parte do padrao. Quando
herda, `plan` e `tune` mostram a linha `perfil herdado do tune anterior`
(`inheritedProfile` no JSON). O backup do `config.ini` no state continua o do
primeiro tune. O emulador sobe com `-gpu host -memory N -cores 2 -port N
-grpc G -grpc-use-token -no-window -no-audio -camera-back none -camera-front
none -feature -Vulkan -no-boot-anim -no-metrics`, com `G = 8554 + (N - 5554)`.
Sem `--port`, o `plan` mostra a linha com `-grpc 8554` e o sufixo `(gRPC 8554
de referencia; porta definida no up)`, porque o `up` escolhe a porta livre na
hora.

O emulador pode subir com mais RAM que o `-memory` pedido (ver "Numeros
medidos"). Depois do boot, o `up` le o `hardware-qemu.ini` (ou, sem ele, a linha
`Increasing RAM size to N MB` do log deste boot), devolve `ramEffectiveMb` e,
se a efetiva passou da pedida, avisa em stderr com os dois valores, o rotulo
`(emulador elevou)` e a linha do log deste boot quando ela existe. A sugestao
do aviso, `tune --screen 720x1600@320`, e tentativa: so ha dois pontos
medidos, nao uma regra.

Se o AVD ja esta rodando, o `up` nao sobe outro e devolve o existente, com
`launcher` e `gpuEffective`. Quando quem lancou nao foi o devslim ou a GPU
efetiva e por software, avisa em stderr com os fatos e a saida: `devslim
android down <avd> --force` e subir de novo. Nunca derruba sozinho.

Quando o `up` sobe sem `slim_base`, a ultima linha sugere `devslim android bake
<avd>` (campo `hint` no `--json`). Partindo do snapshot, nao ha dica.

Swap: `up`, `bake` e `ios up` recusam bootar com swap acima de 95%, com a mesma
mensagem do `doctor`; `--force` boota mesmo assim. Entre 80% e 95% so avisam.
Device que ja estava rodando nunca e bloqueado por swap.

Flags de perfil: `--ram N` (1536 a 8192), `--aggressive` (1536 MB e `-lowram`),
`--gpu M`, `--vulkan`, `--screen keep|LxA@dpi`, `--port N`, `--need a,b`,
`--for <dir>`, `--no-grpc` e `--grpc` (os dois tambem no `bake`). `devslim
android plan <avd>` mostra o diff do `config.ini` e a linha do emulador sem
escrever nada.

O `bake` desliga pacotes da lista gerida que existem na imagem (`--aggressive`
inclui Play Store e assistentes de setup), zera escalas de animacao, desliga
`auto_sync` e a tela de stylus, roda dexopt e `am kill-all`, e grava o snapshot.
Nunca desliga bluetooth nem Chrome. O state fica em
`~/.devslim/state/android/<avd>.json`.

## Fluxo iOS

```
devslim ios plan QA-iPhone17             # so leitura: o que o up desligaria e o que repararia
devslim ios up QA-iPhone17               # escreve o store com o device desligado, boota e confere
devslim ios off QA-iPhone17              # devolve cada label ao valor salvo
```

Aceita UDID ou nome exato. O perfil padrao desliga os 173 labels geridos, em 16
categorias (`devslim ios categories`). Ele quebra push remoto, StoreKit,
universal links e login com Apple ID; religue com `--need` o que o app usa.
`--except cat,cat` mantem categorias inteiras e `--keep label` mantem labels
avulsos.

O `up` salva em `~/.devslim/state/ios/<UDID>.json` o valor anterior de cada label
que muda, e o primeiro backup vence. Depois do boot ele confere com `launchctl
print-disabled`. Se algum label nao pegou, cai em `launchctl disable/enable` por
label e reboota; o que ainda faltar sai na lista e o exit code e 3.

`com.apple.assistantd`, `com.apple.gamed` e `com.apple.sharingd` ficam sempre
ligados. Se o store de um device ja os traz desligados (herdado de outra
ferramenta), o `up` grava os tres como ligados, salva o valor antigo e confere
depois do boot. O `off` devolve o valor salvo. `--keep` e `--except` nao
alcancam esse reparo. `plan` mostra o que seria reparado em `repair`.

## Capacidades

| capacidade | iOS | Android | quando |
|---|---|---|---|
| `audio` | nada | `hw.audioOutput`, sem `-no-audio` | app com som |
| `camera` | categoria `photos` | cameras emuladas | app com camera ou galeria |
| `location` | `com.apple.MapKit.SnapshotService` | `hw.gps=yes`; `bake` mantem o Google Maps (`com.google.android.apps.maps`) | app com mapa ou localizacao |
| `push` | `com.apple.apsd` | nada | expo-notifications |
| `store` | categorias `store` e `icloud` | AVD com Play Store separado | so ao testar compra |
| `weblogin` | categoria `web` | nada, Chrome nunca e desligado | google-signin, universal links |
| `window` | abre o Simulator.app | sem `-no-window` | uso manual |

`--for <dir>` le o `package.json` do app e deriva `audio`, `camera`, `location`,
`push` e `weblogin`. `location` vem de `expo-location`,
`react-native-geolocation-service`, `@react-native-community/geolocation`,
`@rnmapbox/maps` ou `react-native-maps`. `store` e `window` so entram por
`--need`.

No iOS, CoreLocation (`com.apple.locationd`) e GeoServices (`com.apple.geod`,
tiles e geocoding do MapKit) nao estao na lista gerida e nunca sao desligados,
com ou sem `location`. Da lista, `location` so religa o XPC de snapshot do
MapKit. No Android, o enxugamento via adb nunca mexe em settings de localizacao.
Sem `location`, o `bake` desliga o Google Maps junto com os outros apps de
midia; com `location`, ele fica ligado nos dois niveis (padrao e
`--aggressive`), do mesmo jeito que `camera` mantem `com.android.camera2`. Um
`bake` com `location` religa o Maps desligado por um `bake` anterior.

## Convivencia com argent

Fato medido em 2026-11-16: o argent lancou `qa-tablet-api35` sozinho com
`-avd qa-tablet-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio
-no-boot-anim -netfast -no-metrics -crash-report-mode never`. O `config.ini` do
AVD tinha `hw.gpu.mode=host`, mas o `-gpu auto` da linha de comando venceu: o
`hardware-qemu.ini` desse boot saiu com `hw.gpu.mode = lavapipe` (renderizacao
por software) e `hw.ramSize = 4096`. O tune do `config.ini` nao protege contra
isso; quem decide e a linha de comando.

Ordem correta:

1. Suba o device com `devslim android up <avd>`.
2. Abra o argent depois. Comprovado: ele reaproveita o emulador do devslim nas
   ferramentas que usam adb (`reinstall-app`, `launch-app`) e no screenshot. As
   de tela (screenshot, describe, tap) dependem do anuncio gRPC descrito abaixo.
3. Nunca peca ao argent um boot com force sobre um AVD que o devslim gerencia:
   ele relanca com `-gpu auto` e sem `-memory`.

Anuncio gRPC. O argent (simulator-server) descobre o emulador pelo arquivo
`avd/running/pid_<pid>.ini` (no macOS em
`~/Library/Caches/TemporaryItems/avd/running/`, no Linux em
`$XDG_RUNTIME_DIR/avd/running/`) e exige `grpc.port` e `grpc.token` nele. Medido:
o emulador lancado com `-port` e sem `-grpc` nao grava esse arquivo nem sobe o
servidor gRPC, com janela ou sem, e `-grpc-use-token` sozinho nao resolve. Por
isso o devslim lanca sempre com `-grpc <porta> -grpc-use-token`. A porta gRPC e
por instancia: `8554 + (porta do console - 5554)`, ou seja 8554 para
`emulator-5554`, 8556 para `emulator-5556`. Validado em 2026-11-16 com
`qa-tablet-api35` em `-port 5554 -grpc 8554`: o `pid_<pid>.ini` saiu com
`grpc.port=8554` e `grpc.token`, e `argent run screenshot --udid emulator-5554`
funcionou. Tap e describe ainda nao foram conferidos um a um.

Depois do boot, o `up` procura a entrada do AVD (por `avd.name` e
`port.serial`) por ate 10 s e devolve `advertised` e `grpcPort`. Sem entrada
com porta e token, avisa em stderr que ferramentas que dependem de gRPC nao vao
enxergar o emulador; adb funciona normalmente e o exit continua 0. O `status`
e o `doctor` (`emulator-advertised`) mostram o mesmo. O `pid_<pid>.ini` pode
sobrar de um emulador que morreu sem limpar (crash, kill -9). Por isso a
entrada so conta quando o pid do nome do arquivo ainda existe (`kill -0`; sem
permissao conta como vivo). Entrada de pid morto nao vale como anuncio no `up`,
no `status` nem no `doctor`, que so informa quantas ignorou. O devslim nunca
apaga esses arquivos: sao do emulador. `--no-grpc` em `plan`, `tune`, `up` e
`bake` lanca sem as duas flags e nao avisa; o `tune` grava `grpc: false` no
perfil. `--grpc` nos mesmos comandos religa sobre o perfil salvo (`tune --grpc`
grava `grpc: true` de volta); sem nenhuma das duas, vale o que o tune salvou.
As duas juntas sao erro de uso. State gravado antes deste campo vale como
ligado.

Alternativa quando o argent precisa bootar sozinho: exporte
`ARGENT_EMULATOR_GPU_MODE=host` no ambiente do tool-server dele. O `doctor`
avisa quando falta (`argent-gpu`) e quando um emulador ja roda fora do perfil
(`running-off-profile`). O `status` mostra `lancado por argent` e o `up` avisa
se encontrar o AVD rodando assim.

- O snapshot do devslim se chama `slim_base`. O `default_boot` e do emulador e do
  argent, e o devslim nunca grava nele.
- O devslim lanca com `-feature -Vulkan`, igual ao argent, para o probe de
  snapshot do argent nao recusar e regravar `ram.bin`.

## Uso como lib

`src/index.ts` exporta tudo que a CLI usa. Todo processo passa por um `Exec`
injetavel, e os testes usam `createFakeExec`, `createFakeAndroid` e
`createFakeIos`.

```ts
import { collectStatus, runDoctor, doctorExitCode } from 'devslim';

const status = await collectStatus();
if ((status.swap.percent ?? 0) > 80) console.warn('swap alto, nao suba device');
const checks = await runDoctor();
process.exitCode = doctorExitCode(checks);
```

```ts
import { buildAndroidProfile, upAvd, measureAvd } from 'devslim';

const up = await upAvd('slim-api35', buildAndroidProfile({ ramMb: 2048, port: 5556 }));
const m = await measureAvd('slim-api35');
console.log(up.serial, m.host.footprintMb);
```

## Limites conhecidos

- Um device por vez. `up` e `bake` recusam se ja houver emulador ou simulador
  rodando, ou se o swap passar de 95%, salvo `--force`.
- iOS so a partir de 18.5. Antes disso o launchd_sim nao guarda os overrides
  entre boots. tvOS, watchOS e visionOS ficam fora.
- O `disabled.plist` e detalhe interno do CoreSimulator. Por isso o `up` sempre
  confere depois do boot e o `status` aponta drift.
- Nao verificado ainda se a limpeza periodica do macOS alcanca
  `/private/var/tmp`.
- `down` so conhece o que esta registrado na sessao, salvo `--force`.
- A lista de pacotes Android veio do avdslim e o `bake` cruza cada um com
  `pm list packages` antes de desligar. Imagem diferente pode ter nomes que a
  lista nao cobre.
- Nada de GUI, CI, device fisico, clone de device ou limpeza de disco. O `doctor`
  relata imagem orfa e snapshot grande, mas nao apaga.

## Numeros medidos

Uma medicao real ate agora (2026-11-16, bench-api35, pixel_7 1080x2400, API 35
google_apis, tunado, SEM bake, app de mapa aberto, ~30 min de uso):
phys_footprint 5582 MB, cabecalho do footprint 3000 MB, RSS 4034 MB, guest
MemTotal 2473 MB, 288 processos no guest. Sem medicao de baseline no mesmo AVD,
entao ainda nao ha numero de economia. O emulador elevou a RAM de 2048 para
2560 MB.

Tablet 2560x1600 com `-memory 2048`: emulador elevou para 4096 MB. Phone
1080x2400: elevou para 2560 MB.

## Testes

```
node --test --test-concurrency=2
```

Os testes usam AVDs, SDK e store iOS em diretorio temporario, com exec, spawn,
relogio e sleep falsos. Nenhum chama adb, emulator, avdmanager ou simctl de
verdade, nem escreve em `~/.android` ou `/private/var/tmp`.

## Licenca de terceiros

A lista de pacotes Android deriva do avdslim (MIT). Labels e categorias iOS
derivam do simslim (MIT). Ver `NOTICE`.
