# Investigación externa: configuración, lanzamiento, continuación, exportación y lectura

Desde `lib/`, con la configuración de modelos habitual. Spec: [SPEC-INVESTIGACION-EXTERNA](../../SPEC-INVESTIGACION-EXTERNA.md).

## 1. Configuración (`external-research.json`)

[`external-research.json`](external-research.json) es un `external-research@1`:

- `web.access` vale `allowlist` por defecto: sólo se abren los dominios o prefijos de `allow`, y una lista vacía no
  permite nada. La web pública se abre únicamente escribiendo `"access": "public"`. `deny` prevalece en los dos casos.
- `budget` fija las bolsas del run: búsquedas, descargas y bytes. Un cero deshabilita esa operación.
- `search.provider: "brave"` usa Brave Web Search. La clave se toma del entorno, `WEB_SEARCH_KEY`, y nunca va en un
  fichero ni en la URL.
- Un PDF sólo se lee si el entorno declara un extractor: `PDF_EXTRACTOR` es una orden que recibe el PDF por su entrada
  estándar y escribe `{"pages": [...], "version": "..."}`. Sin él, el PDF responde `unsupported_media`.

Los mundos cuya respuesta está publicada (`c302nav`, `c302closed`) no admiten fuentes externas. En ellos las
herramientas no se anuncian y, si se piden, responden `not_allowed` con el motivo del mundo.

## 2. El investigador busca y lee por sí mismo

```powershell
.\lab_two_tier_reasoning.ps1 start cells --researcher assisted --external-research examples\external-research.json --seed 1 --level 1
```

Sólo lo usa el investigador asistido; el puro conserva su condición. Lo que lee queda en el diario:

- `source_search` y `source_acquired`, con los textos guardados en `blobs/`;
- su inventario, en `external_research_inventory`;
- en el finding, `external_research` (acceso, uso y gasto) y `external_exposure`.

Las citas siguen la forma `src:S2#L10-20`.

## 3. El senior, con sus propias bolsas

```powershell
.\lab_two_tier_reasoning.ps1 agent runs\<run>.json --role senior --external-research examples\external-research.json
```

Sus búsquedas quedan en su registro (`<run>.agent-senior.json`, `sources_log`) y sus ids llevan el prefijo
`senior.`. Cada mensaje suyo lleva su exposición, y un mundo que no admite fuentes externas no lo recibe.

## 4. Un operador investigador

```powershell
.\lab_two_tier_reasoning.ps1 agent runs\<run>.json --research examples\operator-research.json
```

[`operator-research.json`](operator-research.json) es un `operator-research@1` que fija:

- **Despertadores:** atasco, cada N rondas o un reloj. El reloj es un horario: no dice que algo vaya mal.
- **Presupuesto:** obligatorio y finito.
- **Mensajes:** un máximo por destinatario.

Cada run debe permitirlo con `--agents scout=message`. Entrega `research-contribution@1`: un informe guardado por su
contenido que llega como mensaje, nunca como directiva. Cada contribución se entrega una sola vez a cada destinatario,
aunque el operador se reanude. Un run terminado no se reabre: la contribución tardía queda en el registro del
operador, `<run>.research-scout.json`.

## 5. Un método propio como programa

En el mundo del junior, con los perfiles que habilita el operador:

```powershell
.\lab_two_tier_reasoning.ps1 start junior --researcher assisted --program-profiles examples\program-profiles.json ...
```

El investigador puede entrenar con una receta `{"method": "program", ...}`, como
[`method-program/train-recipe.json`](method-program/train-recipe.json):

- **Qué lee y qué escribe:** el programa lee `inputs/dataset.jsonl` e `inputs/job.json`, y escribe `out/result.json`
  junto con sus productos.
- **Dónde corre:** sólo donde un backend aislado se demuestra a sí mismo, es decir, en Linux con namespaces y
  Landlock. En Windows y en un perfil GPU responde `unavailable`.
- **Qué se importa:** el producto entra como cambio aprendido de datos (`learned: "trained"`), con las realizaciones
  de sus ejemplos.
- **Quién lo juzga:** el evaluador fijo, nunca el programa.

## 6. Continuación y exportación

`--resume` sirve lo que se buscó y leyó desde el log del run (canales `web` y `search`): no vuelve a preguntar a la red
y conserva la configuración registrada en el diario.

```powershell
.\lab_two_tier_reasoning.ps1 pack runs\<run>.json
```

```powershell
.\lab_two_tier_reasoning.ps1 verify runs\<run>.package
```

El paquete incluye los snapshots, los registros del senior y de los operadores, y los informes de sus
contribuciones. `verify` reconstruye el run sin red, sin buscador y sin inferencia; si falta un snapshot, lo señala
como error de integridad.
