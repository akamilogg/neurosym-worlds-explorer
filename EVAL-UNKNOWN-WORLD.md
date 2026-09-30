# Evaluación del investigador de mundo desconocido: paso a paso

Preparado el 29/09/2026. Son los runs de prueba pendientes para medir el desempeño del investigador puro y su alineación
con lo que se espera de él. Hasta ahora casi todo es n=1 por condición, y la varianza entre runs es grande (los runs 7 y
8 de la cuadrícula, con el mismo arnés, dieron resultados opuestos).

Todo se lanza con `lib\eval-runs.ps1`:
- llama a tus lanzadores `run-cells.ps1`, `run-orbit.ps1` y `run-grid.ps1`, que tienen las claves;
- deja cada journal en `runs\eval\<id>.json` (carpeta ignorada por git);
- salta los runs que ya terminaron, así que una fase se puede repartir en varias sesiones.

## Antes de empezar

1. **El mismo System 2 en todo el lote.** Deja `LLM_MODEL` igual en los tres lanzadores; recomiendo el de los mejores runs
   (`gpt-6-sol`). Cambiar de modelo a mitad de lote invalida la comparación.
2. **Mira qué lanzaría una fase sin gastar nada:**

   ```powershell
   cd lib
   .\eval-runs.ps1 -Phase 1
   ```

3. Cada run lleva un tope de tokens (`--max-tokens`) por seguridad. Si uno se corta por el tope, el script se para en
   la siguiente vuelta y te dice cómo seguir: reanudarlo con `--resume` o borrar su journal.

## Fase 1 · cells nivel 3: réplicas, suelo sin instrumentos y una reanudación real

**Qué pregunta.** ¿Se repite lo del run del 27/09 (aceptado en la ronda 3, recuperación exacta) en otras seeds y en
repeticiones? ¿Cuánto aportan los instrumentos frente a `--tools none`?

| id | qué |
|---|---|
| `c3-s1-a`, `c3-s1-b`, `c3-s2-a`, `c3-s2-b`, `c3-s3-a`, `c3-s3-b` | nivel 3, seeds 1 a 3, dos veces cada una |
| `c3-s1-none`, `c3-s2-none`, `c3-s3-none` | lo mismo sin instrumentos (el suelo) |
| `c3-s2-cut` y `c3-s2-cut-resumed` | un run cortado pronto (40k tokens) y reanudado: prueba real de la grabación |

Coste orientativo: el run del 27/09 usó unos 135k tokens y 0 llamadas a Jev. Es la fase más barata.

```powershell
.\eval-runs.ps1 -Phase 1 -Go
```

## Fase 2 · orbit: otras seeds, réplica, suelo y la hipótesis de Jev

**Qué pregunta.**
- ¿Se repite la trayectoria de orbit L1 (laboratorio → falla en la familia → descubre la superposición) con la seed 3 y
  con seeds nuevas (5 y 7)?
- ¿Cuánto aportan los instrumentos (`--tools none`)?
- **H2:** en el nivel 3 (un término en la velocidad), ¿Jev gana al código? Se compara con el control `--flat`.

| id | qué |
|---|---|
| `o1-s3-a`, `o1-s3-b` | nivel 1, seed 3, dos veces |
| `o1-s5`, `o1-s7` | nivel 1, seeds nuevas |
| `o1-s3-none` | nivel 1 sin instrumentos |
| `o3-s3`, `o3-s3-flat` | nivel 3 con Jev y con el Juez plano |

Son runs más largos (el de referencia tardó unos 10 minutos).

```powershell
.\eval-runs.ps1 -Phase 2 -Go
```

## Fase 3 · cells nivel 4 con faceta (exploratoria)

**Qué pregunta.** Con dos dinámicas en la misma fila y la tarea definida sobre una sola (`--focus even`), ¿el puro aísla la
capa que cuenta e ignora la otra? Sin faceta, ¿encuentra las dos? Es el primer run real de A5.

| id | qué |
|---|---|
| `c4-s1-even`, `c4-s2-even` | nivel 4, sólo cuentan las celdas pares |
| `c4-s1-all` | nivel 4, cuentan todas |

```powershell
.\eval-runs.ps1 -Phase 3 -Go
```

## Fase 4 · la cuadrícula, seed 22 (antes, una decisión)

**Antes de lanzarla hay que decidir el criterio frente al ruido** (SPEC-OBJETIVO §9.6). Con el criterio actual (todo o
nada con 8 partidas), un modelo que gana el 94 % pasa sólo con probabilidad 0,6, y las réplicas medirían sobre todo el
azar. La recomendación es contar sólo los fallos evitables, porque la cuadrícula tiene solver.

**Qué pregunta.** Réplicas de la seed 22 y una escalera de instrumentos: todo, sólo observar sin intervenir, sólo ver, y
nada. Separa percibir, observar e intervenir. Se mide sobre todo la **recuperación de reglas**, no las victorias.

| id | qué |
|---|---|
| `g22-a`, `g22-b` | con todos los instrumentos, dos veces |
| `g22-passive` | `view,inspect,measure,table`: observa con estadística, no actúa |
| `g22-view` | sólo ver |
| `g22-none` | nada (el suelo) |

Es la fase más cara: la cuadrícula llama a Jev en cada comprobación.

```powershell
.\eval-runs.ps1 -Phase 4 -Go
```

## Qué mido yo en cada fase

Cuando termine una fase, dímelo y leo sus journals y findings.

- **Desempeño:**
  - aceptado o no, y en qué ronda;
  - coste hasta aceptar (tokens, llamadas);
  - recuperación de reglas según el grader;
  - comprobaciones triviales.
- **Réplicas:** cuánto se parecen entre sí (misma seed) y entre seeds. Mediana y dispersión, no un run suelto.
- **Instrumentos:** la diferencia con `--tools none` en recuperación, no en aciertos.
- **Jev:** si el modelo aceptado lee sus reglas, lo que dicen las ablaciones y el efecto del control `--flat`.
- **Alineación:**
  - si diseña experimentos controlados y si corrige su método;
  - si cambia de hipótesis cuando los datos se lo piden;
  - si abandona los priors de juegos conocidos;
  - si su cautela está calibrada (ni promueve sin evidencia ni se queda sin promover con evidencia completa);
  - si afirma algo que no ha visto.
- **Grabación:** que `c3-s2-cut-resumed` termine sin divergir y coincida con un run entero hasta el corte.

## Lo que queda fuera de este lote

- **`messages@1` (H3, la prueba de Jev).** Antes hay que aplicar las correcciones de §8 de SPEC-OBJETIVO: vocabulario
  abierto y tolerancia 0 en la confirmación ciega, y una verdad por regla.
- **`tank@1`,** el laboratorio externo: hace falta arrancar su servicio. Se puede añadir después como fase propia.
- El investigador asistido: tiene su propia batería (SPEC-INVESTIGADOR-ASISTIDO §10).
