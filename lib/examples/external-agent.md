# Un agente externo en una investigación

Guía de [SPEC-INVESTIGACION-EXTERNA](../../SPEC-INVESTIGACION-EXTERNA.md) §6.4 y §7.1 (IE7 a IE9). Un agente con
herramientas propias (Claude Code, Codex, un script, una persona en una terminal) se une a una investigación por la
línea de comandos de `lab`. No hay SDK ni servicio que arrancar: cada orden lee y escribe ficheros y responde JSON.

`lab external guide` imprime el contrato completo; es lo primero que debe leer el agente.

## 1. El operador lo autoriza

Un fichero `external-agent@1`:

```json
{
  "format": "external-agent@1",
  "id": "scout",
  "task": "el artefacto es lento con muchas claves; ayuda si ves cómo",
  "targets": ["runs/artifacts-dedup-s1.json"],
  "mode": "contribute",
  "artifacts": { "max_bytes": 1048576, "max_total_bytes": 8388608 },
  "budget": { "max_contributions": 2, "max_reads": 10, "minutes": 120 },
  "declares": { "repository": true, "web": true }
}
```

Y cada run acepta sus mensajes, como los de cualquier agente:

```bash
lab start artifacts --researcher assisted --agents scout=message ...
```

`declares` es una nota para quien lea el finding: lo que el operador sabe del acceso del agente. No relaja nada.

## 2. El agente contribuye (modo `contribute`)

```bash
lab external open scout.agent.json
```

Devuelve la sesión: la ruta de su registro (`<run>.research-scout.json`). Las órdenes siguientes la reciben.

```bash
lab external read <sesión> artifacts-dedup-s1
```

Lee el run como lo vivió su investigador; gasta una lectura.

```bash
lab external formats <sesión> artifacts-dedup-s1
```

Dice qué artefactos admite su mundo y cómo se adoptan.

```bash
lab external check <sesión> artifacts-dedup-s1 fast.json --as artifact-files@1
```

Comprueba el artefacto como lo haría el importador, sin gastar nada.

```bash
lab external contribute <sesión> --to artifacts-dedup-s1 --report informe.md --summary "un conjunto en vez de una lista" --artifact artifact-files@1=fast.json --tested pruebas.txt
```

Entrega la contribución. `--tested` es lo que el agente dice haber probado fuera del entorno del investigador; se le
muestra como afirmación suya, nunca como evidencia de su mundo.

```bash
lab external status <sesión>
```

Muestra si la contribución llegó, si se citó, si se adoptó y qué respondió el mundo al investigador.

```bash
lab external close <sesión>
```

Formatos por mundo:

| Mundo | Formato | Contenido |
|---|---|---|
| Artefactos | `artifact-files@1` | `{"files": {"main.py": "<texto entero>", "viejo.py": null}}` |
| Junior | `method-program@1` | un programa de método (IE5) que aprende de `dataset.jsonl` |
| Junior | `mask@1` | `{"format": "mask@1", "deletions": [{"module": "<nombre>", "indices": [<índices planos>]}]}` |

Los mundos de leyes no declaran formatos: reciben sólo el informe. Un mundo que no admite fuentes externas
(`c302nav`, `c302closed`) no recibe nada de un agente externo.

## 3. El investigador adopta

El mensaje que entrega la contribución explica cómo adoptarla. Adoptar es un acto suyo:

```json
{"act": {"adopt": {"contribution": "C1-scout", "artifact": "fast.json", "from": "<versión>", "why": "...", "expect": "..."}}}
```

El registro guarda el acto propio del mundo (un `change` con sus ficheros, un `train` con su programa) y marca de qué
contribución viene (`contributed`). En el junior, una máscara adoptada lleva `learned: "contributed"` y la confirmación
la rechaza: se desconoce de qué datos salió. Un programa adoptado se ejecuta con los datos del run y lleva lo que el host
observó (`trained` y sus realizaciones).

## 4. El agente ocupa un asiento (modo `seat`)

El operador arranca el run (o el senior, o el operador investigador) con `LLM_URL=seat:<carpeta>` y
`LLM_MODEL=<un nombre>`. Cada vez que el arnés preguntaría al modelo, deja el turno en la carpeta:

```bash
lab external turn <carpeta>
```

Devuelve los turnos pendientes, cada uno con su id y la petición tal como la recibiría un modelo: sistema y mensajes.

```bash
lab external answer <carpeta> <turno> respuesta.json
```

Entrega la respuesta: el objeto JSON que admite el papel. Cada turno se responde una sola vez.

El run espera sin plazo. Si se para o se interrumpe, se reanuda desde su punto de control con `--resume` y pregunta de
nuevo, en un turno nuevo. El journal registra `llm_provider: "external-seat"` y nunca la carpeta. La exposición del run
es directa y `unobserved`.
