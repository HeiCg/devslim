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
| `avd-ram` | RAM do ultimo boot acima do `config.ini` ou acima de 3072 MB; quando o emulador elevou, o fix e `tune <avd> --lowram` |
| `profile-drift` | AVD com state do devslim cujo `config.ini` difere do que o perfil salvo produziria; warn lista cada chave como `chave: atual=X esperado=Y` |
| `avd-image` | tag da system image (`tag.id`, senao `image.sysdir.1`) de cada AVD com state x capacidades que dependem de servicos Google (`push`, `weblogin`, `store`). `google_apis` ou playstore sem nenhuma delas: linha ok com a sugestao de ATD e o numero medido. ATD ou `default` com alguma delas: warn. AVD ausente, `config.ini` ilegivel ou sem tag: pulado |
| `running-off-profile` | emulador rodando agora com GPU por software, ou AVD tunado lancado por outro que nao o devslim; fix em duas linhas (subir com `devslim android up` ou `ARGENT_EMULATOR_GPU_MODE=host`) |
| `emulator-advertised` | emulador rodando sem entrada viva com `grpc.port` e `grpc.token` em `avd/running/`; o argent nao o enxerga para screenshot e tap. Entradas de pid morto viram uma linha ok com a contagem |
| `argent-gpu` | argent no PATH sem `ARGENT_EMULATOR_GPU_MODE=host` |
| `default-boot-snapshot` | AVD com `snapshots/default_boot/ram.bin`, com o tamanho |
| `orphan-images` | system image que nenhum `config.ini` usa, com o tamanho; nunca apaga |
| `swap` | acima de 80% e warn, acima de 95% e fail (mesmos limites e mesma mensagem da recusa do `up`) |
| `ios-always-enabled` | store de simulador que desliga assistantd, gamed ou sharingd |
| `stale-session` | entradas mortas na sessao |

`avd-image` so le. A nota de imagem mais leve sai como ok (nao conta como warn
nem muda o exit) e traz o fix `devslim android create <avd>-atd --image
aosp_atd`, com `--api N` quando a imagem atual nao e da API 35. O warn de ATD
com `push`, `weblogin` ou `store` diz que a capacidade nao funciona nessa imagem
(no `google_atd`, que tem servicos Google reduzidos, diz que pode nao funcionar)
e sugere `create <avd>-gapis --image google_apis`.

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
devslim android create slim-api35        # AVD novo (google_apis); aplica o tune com tela 720x1600@320, nao boota
devslim android create ui-api35 --image aosp_atd   # ou: imagem ATD, mais leve, para teste de UI e logica
devslim android tune slim-api35          # ou: tune num AVD existente (backup do config.ini antes)
devslim android bake slim-api35          # uma vez: boota, enxuga via adb, grava slim_base, desliga
devslim android up slim-api35            # dia a dia: sobe do slim_base com flags economicas
devslim down                             # desliga o que subiu
devslim android up slim-api35            # restore precisa do AVD rodando se houve bake
devslim android restore slim-api35       # religa pacotes, devolve settings e o config.ini byte a byte
```

O `tune` grava RAM (padrao 2048 MB; ver abaixo o piso do emulador), heap, 2
cores, `hw.gpu.mode=host`, sensores, GPS e cameras desligados, e apaga `hardware-qemu.ini` e `snapshots/`, que o
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
none -feature -Vulkan -no-boot-anim -no-metrics`, com `G = 8554 + (N - 5554)`, e
`-lowram` antes de `-no-boot-anim` quando o perfil tem lowram.
Sem `--port`, o `plan` mostra a linha com `-grpc 8554` e o sufixo `(gRPC 8554
de referencia; porta definida no up)`, porque o `up` escolhe a porta livre na
hora.

Piso de RAM. O emulador eleva sem erro qualquer `-memory` abaixo do piso dele,
a menos que o `-lowram` esteja ligado (ver "Numeros medidos"). Pisos vistos ate
agora: 2560 MB num phone pixel_7 e 4096 MB num tablet 2560x1600; sao duas
observacoes, nao uma regra. Tela menor nao baixa o piso: com 720x1600@320 o
emulador continuou em 2560 MB. `--ram 1536` sem lowram tambem virou 2560 MB.
Com lowram o pedido vale (`--aggressive`, 1536 MB com lowram, ficou em 1536
MB), mas o guest passa a se declarar aparelho de pouca RAM, o que muda o
comportamento dos apps.

Depois do boot, o `up` le o `hardware-qemu.ini` (ou, sem ele, a linha
`Increasing RAM size to N MB` do log deste boot), devolve `ramEffectiveMb` e,
se a efetiva passou da pedida, avisa em stderr com os dois valores, o rotulo
`(emulador elevou)`, a linha do log deste boot quando ela existe e a saida:
`devslim android tune <avd> --lowram` com o AVD desligado, com o aviso de que o
lowram muda o comportamento dos apps. Se o perfil ja tinha lowram, o aviso diz
`emulador elevou mesmo com lowram` e nao sugere nada.

`plan` e `tune` imprimem uma linha `nota:` (campo `ramNote` no JSON, `null`
sem nota) quando o perfil pede menos de 2560 MB sem lowram: o emulador deve
elevar o pedido, com os dois pisos observados, e `--lowram` faz o pedido valer.
Se o ultimo boot deste AVD (o `hardware-qemu.ini`, lido antes do `tune` apaga-lo)
mostra que o emulador elevou o pedido, a nota cita esse valor no lugar dos pisos
genericos e some quando o pedido novo ja passa dele.

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
`--lowram`, `--no-lowram`, `--gpu M`, `--vulkan`, `--screen keep|LxA@dpi`,
`--port N`, `--need a,b`, `--for <dir>`, `--no-grpc` e `--grpc`. `--lowram`,
`--no-lowram`, `--no-grpc` e `--grpc` tambem valem no `bake`. `devslim android
plan <avd>` mostra o diff do `config.ini` e a linha do emulador sem escrever
nada.

`--lowram` liga `-lowram` sem mudar a RAM; o `tune` grava `lowRam: true` no
perfil e os comandos seguintes herdam. `--no-lowram` tira o lowram salvo ou o
do `--aggressive` (`--aggressive --no-lowram` = 1536 MB sem lowram). As duas
juntas sao erro de uso. `--aggressive` continua sendo 1536 MB mais lowram em
`plan`, `tune` e `up`; no `bake` ele e so o nivel da lista de bloat.

`create` aceita em `--image` o id completo
(`system-images;android-35;google_apis;arm64-v8a`) ou um atalho: `google_apis` (padrao), `google_atd`, `aosp_atd` ou `default`,
expandido para `system-images;android-<api>;<tag>;<abi>`. `--api N` escolhe a
API do atalho (padrao 35) e nao combina com id completo. A ABI segue o host:
`arm64-v8a` no Apple Silicon, `x86_64` no resto. Antes de chamar o
`avdmanager`, o `create` confere se a imagem existe em
`<sdk>/system-images/android-<api>/<tag>/<abi>`; se nao existe, para com o
comando exato `sdkmanager "<id>"`. O devslim nunca baixa imagem sozinho.

Qual imagem usar. As imagens ATD nao tem servicos Google (`aosp_atd`) ou tem
servicos reduzidos (`google_atd`); `default` e AOSP puro. Sao mais leves (ver
"Numeros medidos"), mas no `aosp_atd` nao ha login com Google, push FCM nem
compra com Play Billing. Use ATD para teste de UI e de logica, e `google_apis`
quando o teste precisa de login, push ou compra. O `doctor` (`avd-image`)
aponta os dois desencontros.

O `bake` desliga pacotes da lista gerida que existem na imagem (`--aggressive`
inclui Play Store, assistentes de setup e o Gboard), zera escalas de animacao,
desliga `auto_sync` e a tela de stylus, roda dexopt e `am kill-all`, e grava o
snapshot.
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
| `keyboard` | nada | `bake --aggressive` mantem o Gboard (`com.google.android.inputmethod.latin`) | testar layout que desvia do teclado na tela |
| `location` | `com.apple.MapKit.SnapshotService` | `hw.gps=yes`; `bake` mantem o Google Maps (`com.google.android.apps.maps`) | app com mapa ou localizacao |
| `push` | `com.apple.apsd` | nada | expo-notifications |
| `store` | categorias `store` e `icloud` | AVD com Play Store separado | so ao testar compra |
| `weblogin` | categoria `web` | nada, Chrome nunca e desligado | google-signin, universal links |
| `window` | abre o Simulator.app | sem `-no-window` | uso manual |

`--for <dir>` le o `package.json` do app e deriva `audio`, `camera`, `location`,
`push` e `weblogin`. `location` vem de `expo-location`,
`react-native-geolocation-service`, `@react-native-community/geolocation`,
`@rnmapbox/maps` ou `react-native-maps`. `store`, `window` e `keyboard` so
entram por `--need`.

O Gboard so entra na lista `--aggressive`, nunca na padrao. Sem ele o texto
continua chegando por `adb shell input` ou pelo input do argent, mas nao da
para testar layout que desvia do teclado na tela; para isso use `--need
keyboard`. Um `bake` com `keyboard` religa o Gboard desligado por um `bake`
anterior, e o `restore` religa como qualquer pacote da lista. Imagem que nao
tem o Gboard so pula o pacote, como qualquer outro da lista.

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

Medido em 2026-11-17 num Mac Apple Silicon, uma medicao por linha, 2 min
parado depois do boot, sem app aberto.

Android, API 35 arm64, pixel_7:

| perfil | RAM efetiva | phys_footprint do qemu no host | processos no guest |
|---|---|---|---|
| `google_apis` sem devslim, headless, `-gpu auto` (caiu em lavapipe) | 2560 MB | 5525 MB | 341 |
| devslim padrao (pede 2048), tela original | 2560 MB | 4590 MB | 325 |
| devslim padrao, tela 720x1600@320 | 2560 MB | 4343 MB | 313 |
| devslim `--ram 1536`, sem lowram | 2560 MB (elevada) | 4469 MB | 311 |
| devslim `--aggressive` (1536 e `-lowram`) | 1536 MB | 3444 MB | 290 |
| devslim padrao em imagem `aosp_atd` | 2560 MB | 3660 MB | 262 |

O que as linhas mostram:

- O emulador eleva qualquer `-memory` abaixo do piso dele (2560 MB neste phone;
  4096 MB visto num tablet 2560x1600), a menos que o `-lowram` esteja ligado.
  `--ram 2048` e `--ram 1536` sozinhos nao valem.
- Tela menor nao baixa o piso: a RAM efetiva ficou em 2560 MB.
- Imagem sem servicos Google economiza mais ou menos o mesmo que o lowram.
- No guest, o Google Play Services usou 391 MB de PSS e o Gboard
  (`com.google.android.inputmethod.latin`) 81 MB.

iOS, iPhone 17, iOS 26.4:

| perfil | processos | memoria |
|---|---|---|
| sem devslim | 279 | 4629 MB |
| devslim padrao (boot 3.4 s) | 67 | 953 MB |

Ressalvas:

- Uma medicao por linha, sem app aberto.
- A base do Android rodou headless. A base do iOS foi o primeiro boot de um
  simulador recem criado.
- O `footprint` reporta dois numeros para o qemu: o cabecalho e o
  `phys_footprint`. As tabelas usam o `phys_footprint`, que nesse processo
  diverge do cabecalho; compare as linhas entre si em vez de ler os valores
  absolutos.

Uso real no iOS (2026-11-17, perfil enxuto, iOS 26.4, iPhone 17 e iPad Pro 13,
build release de simulador com bundle embutido): boot em cerca de 6,6 s, app
instalado, login, mapa, busca, rota e chamadas de API funcionaram. Efeito
colateral visto: um alerta "Poor Internet Connection" no primeiro launch, uma
vez; depois a rede funcionou. Ainda nao conferido: app Expo em dev build
conectando no Metro.

Medicao anterior, em outras condicoes (2026-11-16, bench-api35, pixel_7
1080x2400, API 35 google_apis, tunado, sem bake, app de mapa aberto, ~30 min de
uso): phys_footprint 5582 MB, cabecalho do footprint 3000 MB, RSS 4034 MB, guest
MemTotal 2473 MB, 288 processos no guest; o emulador elevou a RAM de 2048 para
2560 MB.

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
