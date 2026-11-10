# SPEC · Consolidación: un diario con esquema, piezas comunes y evidencia comprobable

Estado (10/11/2026): **propuesta, sin implementar**. Sale del [repaso del repositorio](REPASO-2026-11-10.md) (§4.2 y
§5.2). No añade ninguna capacidad: reduce a una las piezas que el arnés tiene repetidas, da tipo al diario y deja los
hallazgos comprobables desde fuera. Toca el runner ([SPEC-OBJETIVO](SPEC-OBJETIVO.md) O9), los registros de
[delegación](SPEC-DELEGACION-INVESTIGACIONES.md), del [motor evolutivo](SPEC-DELEGACION-EVOLUTIVA.md), del
[mundo vivo](SPEC-ACONTECIMIENTOS-DEL-MUNDO.md) y del [junior](SPEC-METAPOLITICA-APRENDIZAJE.md), y los paquetes de
[SPEC-RIESGO-MODELOS](SPEC-RIESGO-MODELOS.md).

## 1. De dónde sale

El arnés creció por capas, cada una con su spec y sus pruebas. Cada capa resolvió bien sus problemas, y varias
resolvieron el mismo:

- **El diario del run** es el contrato del que leen la auditoría, la consola, la escalada, el regrado, los paquetes y el
  metalaboratorio. Se escribe con 104 tipos de evento que ningún tipo declara, y se lee comparando cadenas sobre
  `Record<string, any>`.
- **El runner lo reescribe entero en cada evento,** sin escritura atómica (`lib/src/runtime/lab-runner.ts:850`). Un
  diario largo pasa de 2 MB.
- **Hay cinco registros que sólo crecen,** tres presupuestos, dos ciclos de vida de rama, tres almacenes por contenido y
  tres formas de ejecutar código aislado. Sólo el registro del junior recupera una línea cortada por una parada; sólo su
  libro de trabajos distingue lo reservado, lo gastado y lo incierto.
- **`runLawLab` es una función de unas 1.100 líneas.** El fallo de la segunda revisión de WE5 (entregas de una rama
  perdidas con `--resume`) venía de cómo repite los actos al reanudar.
- **Los hallazgos del README se apoyan en diarios que no se publican,** sin un índice que diga qué paquete respalda cada
  afirmación.

Nada de esto ha roto un resultado todavía. La campaña de ejecuciones reales (repaso §6.1) es el momento en que más
costaría que lo hiciera.

## 2. Principios

- **K1. Nada cambia para el investigador.** Ningún prompt, ningún acto y ninguna respuesta del mundo cambian. Un diario
  hecho antes se sigue leyendo, reanudando y regradando.
- **K2. Una pieza, una garantía.** Donde hay varias implementaciones se conserva la que da la garantía más fuerte y las
  demás pasan a usarla. No se diseña una pieza nueva si una existente sirve.
- **K3. La red son los diarios que ya existen.** Cada entrega se acepta reproduciendo diarios reales grabados
  (`replay.jsonl`) y comparando el resultado byte a byte, salvo los campos que la entrega declara.
- **K4. Por costuras, no de una vez.** Cada entrega es pequeña, se puede dejar a medias sin romper nada y no depende de
  que se hagan las siguientes.
- **K5. Lo deliberado se respeta.** Los dos motores evolutivos (programas y pesos) siguen separados (SPEC-EDICION-PESOS
  §6): comparten principios y aún no hay una ejecución que diga qué merece unificarse.

## 3. El diario

### 3.1 Esquema

Un módulo `runtime/journal.ts` declara cada evento como un tipo con su nombre y sus campos:

```ts
export type JournalEvent =
  | { t: number; type: 'check'; round: number; place: string; holds: boolean; /* … */ }
  | { t: number; type: 'operator_message'; messages: readonly OperatorMessage[] }
  | /* … uno por tipo … */;
```

- **El escritor** (`log`) sólo acepta un `JournalEvent`.
- **Los lectores** (auditoría, consola, escalada, regrado, paquetes, metalaboratorio) leen por una función
  `eventsOf(journal, type)` que devuelve el tipo estrecho. Las comparaciones de cadena sueltas desaparecen.
- **Lo que un laboratorio añade a un evento** (`operator.check`, `operator.start`) va en un campo `lab` de tipo abierto,
  separado de los campos comunes.
- **Un evento desconocido se conserva y se dice,** nunca se descarta: un diario de una versión posterior se puede leer.
- El esquema lleva versión (`journal@2`). Un diario sin ella es `journal@1` y se lee con las mismas funciones.

El inventario de los 104 tipos se hace primero y se revisa: los que sean el mismo hecho con dos nombres se anotan, no se
renombran (K1).

### 3.2 Escritura

- **Cada evento se añade como una línea** a `<run>.events.jsonl`, con la pieza común de §4.1.
- **El fichero `<run>.json` sigue existiendo** con la misma forma, para los lectores y herramientas de ahora. Se escribe
  al cerrar el run y, mientras tanto, cada N eventos o segundos, siempre a un fichero temporal que se renombra.
- **Al reanudar manda el registro de líneas:** si `<run>.json` es más corto que `events.jsonl`, se rehace desde éste.
- El estado (`status.json`) se escribe igual, con renombrado.

## 4. Piezas comunes

### 4.1 El registro que sólo crece

`junior/jsonl.ts` (`appendRecord`, `trimFragment`) pasa a `core/record.ts` y lo usan el diario, `runtime/replay.ts`,
`living/record.ts`, el motor evolutivo, la delegación, los buzones y los fondos. Garantías, las que ya tiene:

- una línea por registro, escrita de una vez;
- una última línea cortada se recorta al abrir y se dice; nunca se reescribe lo anterior;
- una clave por registro donde el registro se sirve al reanudar.

### 4.2 La identidad por contenido

`core/hash.ts` gana `sha256(bytes)` y `contentId(value)` (sha256 del JSON canónico). Las 30 llamadas directas a
`createHash` pasan a usarlos. El FNV-1a de 32 bits (`hashString`, `specHash`) queda para claves de caché y nombres
cortos, y se documenta que no identifica nada que se verifique. Cambiar un identificador ya escrito en diarios o
paquetes está fuera de alcance (K1): se listan los usos de FNV que nombran algo verificable y se deciden uno a uno.

### 4.3 El presupuesto

`JobLedger` (`junior/jobs.ts`) pasa a `core/ledger.ts`. Lo usan el fondo de delegación y el fondo de una rama evolutiva,
que hoy llevan su cuenta aparte. Los topes del run (`--max-tokens`, `--max-minutes`, `--max-judge-calls`) no cambian de
comportamiento: son topes, no bolsas.

### 4.4 La rama

Un módulo `runtime/branch.ts` con el ciclo de vida que comparten `runtime/evolve-branch.ts` y `junior/weight-branch.ts`:
su registro, el latido con su proceso, el buzón obedecido antes del siguiente paso, el hallazgo, y la regla de que una
rama terminada no vuelve a correr. Cada rama aporta sólo su paso y su hallazgo.

### 4.5 Lo que se declara y no se unifica

- **Ejecución aislada.** `artifacts/sandbox.ts`, `runtime/node-vm.ts` y `junior/isolation.ts` sirven a cosas distintas.
  Se escribe una tabla única (en `lib/README.md`) con lo que cada una garantiza y lo que no, y cada una gana una
  autoprueba como la que ya tiene `linux-userns-landlock@1`.
- **Almacenes de blobs.** Se comparte la función de identidad (§4.2); la disposición en disco de cada uno se queda.

## 5. El runner y `Lab`

### 5.1 `runLawLab` por costuras

Se extraen, una por una y en este orden, las partes que ya tienen frontera en el código:

1. la reanudación: qué se sirve del registro y qué se vuelve a pedir (`recorded`, `effects`, la repetición de actos);
2. el canal y lo que publica el mundo;
3. la delegación y las entregas de ramas;
4. el equipo y su tablón;
5. el mundo vivo.

Cada parte recibe un contexto explícito en lugar de capturar variables del cierre. La función que queda ordena las fases
de una ronda y nada más. Ninguna extracción cambia el orden de los eventos (K3).

### 5.2 Capacidades de `Lab`

Los ganchos de un solo mundo (`artifact`, `living`, `dependents`, `lineage`, `rebuild`, `archive`,
`goesOnAfterAcceptance`) se agrupan en capacidades con nombre (`lab.capabilities.artifact`, `.living`, `.rebuildable`).
El runner pregunta por la capacidad, no por cada gancho. Es un cambio de forma: los doce laboratorios declaran lo mismo
que hoy.

### 5.3 El orden de las capas

`core` ← `learn` ← `worlds` ← `runtime`. Se quitan los tres saltos que hay: `learn/explorer.ts` y `runtime/regrade.ts`
sobre la cuadrícula, y `runtime/evolve-branch.ts` y `runtime/package.ts` sobre el mundo de artefactos (pasan por la
capacidad `artifact`). Una prueba recorre los `import` y falla si aparece otro.

## 6. Evidencia y documentación

- **Índice de evidencia.** `EVIDENCIA.md`, versionado: una fila por afirmación del README, con los paquetes (`lab pack`)
  que la respaldan, su hash, el modelo, las repeticiones y el nivel («sólido» o «señal»). Los paquetes pueden vivir
  fuera del repositorio; el hash, dentro. Una afirmación sin fila se marca como tal en el README.
- **Integración continua local.** Un script `lib/scripts/ci.ts` lanza `typecheck`, la suite y `bundle:check`, y escribe
  un resumen. Sin servicios externos: se lanza a mano o desde un gancho de git. La prueba inestable
  (`artifact-world.test.ts`) se arregla o se aísla con su motivo.
- **Estado de las specs.** Una tabla `SPECS.md` generada desde las cabeceras: spec, estado, fecha, etapas hechas y
  pendientes. Una prueba falla si una cabecera dice «sin implementar» y el cuerpo tiene una sección «Implementado».
- **Prefijos de etapa.** Los que chocan (`MA` de la auditoría y de la metapolítica de aprendizaje; `H` del mundo vivo y
  de la delegación evolutiva; `M1` de la metapolítica y del riesgo de modelos) se citan desde ahora con su spec delante
  (`AUDITORIA·MA4`). No se renumeran: están en commits y diarios.
- **`lib/README.md`** se rehace como mapa de módulos y contratos; el README raíz sigue siendo el de la idea y los
  hallazgos.
- **Specs que ya no son contratos** (Y-SI, BUSQUEDA-HIPOTESIS, RULENET, APRENDIZAJE-DIFFS-Y-ACCIONES) pasan a
  `historico/`, con sus enlaces actualizados.

## 7. Límites

- **No mejora ningún resultado.** Sólo baja el coste de un fallo durante la campaña y de cada cambio posterior.
- **El esquema del diario puede fosilizar errores:** dos eventos que son el mismo hecho quedan con dos nombres.
- **Partir el runner tiene riesgo propio.** La red (K3) cubre los mundos con diarios grabados; el mundo vivo y el junior
  no tienen ninguno real, así que sus costuras se hacen las últimas y después de su primera ejecución.
- **El índice de evidencia no hace reproducible lo que depende de un modelo que cambia:** dice qué se midió y con qué.

## 8. Entregas

| Etapa | Depende de | Entrega |
|---|---|---|
| **CC1 · El diario** | — | Inventario de eventos, `journal@2` con sus tipos, `eventsOf`, escritura por líneas con `<run>.json` derivado y atómico, reanudación desde el registro de líneas |
| **CC2 · Piezas comunes** | CC1 | `core/record.ts`, `sha256` y `contentId` en `core/hash.ts`, `core/ledger.ts` usado por los fondos de delegación y de rama |
| **CC3 · El runner** | CC1 | `runLawLab` partido en las cinco partes de §5.1; el orden de las capas con su prueba |
| **CC4 · Capacidades de `Lab`** | CC3 | Los ganchos de un mundo agrupados; los doce laboratorios migrados |
| **CC5 · La rama** | CC2 | `runtime/branch.ts`; las ramas evolutiva y de pesos sobre él; la tabla y las autopruebas de la ejecución aislada |
| **CC6 · Evidencia y documentación** | — | `EVIDENCIA.md`, `scripts/ci.ts`, `SPECS.md` con su prueba, `lib/README.md`, `historico/` |

**CC1 y CC6 van antes de la campaña de ejecuciones reales.** CC2 a CC5 se intercalan con ella. Las costuras del mundo
vivo y del junior (parte de CC3 y CC5) esperan a su primera ejecución real.

## 9. Aceptación

1. El diario de paridad del repositorio y una muestra de los locales (al menos uno por mundo con ejecuciones)
   se reproducen desde su `replay.jsonl` y dan el mismo `<run>.json`, salvo el campo de versión del diario.
2. Un proceso matado en mitad de un evento deja un run que se reanuda sin perder ningún evento anterior y sin pedir de
   nuevo nada ya respondido.
3. Un evento con un campo mal escrito no compila; un tipo de evento sin declarar, tampoco.
4. Un diario `journal@1` se lee, se audita, se regrada y se empaqueta igual que antes.
5. No queda ninguna llamada a `appendFileSync` ni a `createHash` fuera de `core/record.ts` y `core/hash.ts`.
6. El fondo de delegación de un run reanudado da las mismas cifras que hoy, incluidas las inciertas.
7. Los prompts de todos los mundos y configuraciones son idénticos byte a byte antes y después de cada entrega (una
   prueba nueva que los fija para los doce laboratorios antes de empezar CC1).
8. La prueba del orden de capas pasa sin excepciones declaradas.
9. Cada hallazgo del README tiene su fila en `EVIDENCIA.md`, o dice que no la tiene.
