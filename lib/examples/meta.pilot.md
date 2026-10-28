# Metapolítica, M3: piloto con investigadores reales

SPEC-METAPOLITICA-INVESTIGACION §13, M3. Las órdenes se lanzan desde `lib/`, con la configuración de modelos habitual: el
lanzador lleva las claves del LLM y del Judge.

**El junior es el mismo en todas las condiciones.** Su modelo es el que configure el lanzador, y queda registrado en
cada run. El resto lo fija `meta.pilot.json` antes de lanzar nada:
- 8 rondas;
- 8 ayudas de presupuesto;
- memoria selectiva;
- 800 000 tokens;
- 20 000 llamadas al Judge;
- 240 minutos.

Cada ensayo sólo lanza trabajo que el fondo puede reservar: los tokens del junior y las llamadas a su Judge. El
manifiesto no admite delegación, agentes ni apertura, porque nada en él acota su gasto. La condición con senior es la
del lote (§1), no la de un ensayo.

Ningún modelo ni presupuesto histórico se toma por defecto. Conviene un junior pequeño, con el que haya progreso
posible pero no trivial: los runs de septiembre con un modelo fuerte resolvían cells nivel 3 en tres checks.

## 1. Condiciones del §10, sobre casos de desarrollo

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.meta-pilot.json
```

Doce runs: tres casos de naturaleza distinta (`cells-l3-s1`, `orbit-l2-s3`, `grid-s22`) por cuatro condiciones.

| Condición | Qué permite saber |
|---|---|
| A, el junior solo | La referencia del investigador pequeño. |
| B, recordatorio fijo (`research-policies/reminder.json`) | Si basta con recordar que hay que contrastar alternativas. Su texto y su calendario (la primera pregunta de cada ronda par desde la 2) están fijados desde antes de probar candidatas. |
| C, candidata situada (`research-policies/situated.json`) | Si un diagnóstico hecho a partir de su recorrido añade capacidad. Es sólo código: hechos, sin juicios. Da como mucho un consejo por ronda y no repite el mismo en dos rondas. |
| D, el senior actual | Cuánto de su orientación y de su capacidad total sustituye la política. |

**La política más el senior** (complementariedad) es otra condición. Se añade aparte, cuando interese, y nunca se
mezcla con la sustitución.

**Qué se lee:**
- **Los resultados del lote:** `lab batch results <lote>/batch.json`, por condición, con coste.
- **La escalada en el Observatorio:** el consejo de la política aparece como cuerda propia, «consejo de la política»,
  separada de las directivas del senior.
- **Los registros:**
  - `research_policy_requested`, `research_policy_decided` y `research_policy_delivered`;
  - qué hizo el junior después de cada consejo (`lab meta inspect` sobre otro run, o `{"experience": "guidance"}`
    para un investigador exterior).

**Con tres casos es un piloto descriptivo, no una comparación con valor estadístico.** Un resultado negativo bien
fundamentado también vale: una política puede diagnosticar bien y no ayudar al junior a inventar el experimento
necesario.

## 2. Ensayos de la candidata en el meta-laboratorio

```powershell
.\lab_two_tier_reasoning.ps1 meta trials examples\meta.pilot.json examples\research-policies\situated.json
.\lab_two_tier_reasoning.ps1 meta trials examples\meta.pilot.json examples\research-policies\reminder.json
.\lab_two_tier_reasoning.ps1 meta verify examples\meta.pilot.json
```

**Qué hacen:**
- **`trials`** ejecuta cada política en los cinco casos de desarrollo, en `runs/meta/meta-pilot/`. Cada ensayo se
  anota antes de lanzarse y nunca se repite.
- **Si se corta,** se vuelve a lanzar la misma orden: lo terminado se lee y lo cortado se reanuda.
- **`verify`** relee cada ensayo y reconstruye cada decisión sin Judge.

**Desarrollo y confirmación:**
- **Los casos de confirmación** (`cells-l3-s7`, `orbit-l2-s8`, `grid-s26` y `artifacts-dedup-s1`, que comprueba si se
  transfiere a la optimización) los ejecuta el operador. Se hace sólo para una candidata congelada:
  `meta trials ... --partition confirmation`.
- **Si después se desarrolla a partir de ese resultado,** esos casos pasan a desarrollo y hacen falta casos nuevos.

## 3. Desarrollar la política, si los ensayos lo justifican

```powershell
.\lab_two_tier_reasoning.ps1 meta search examples\meta.pilot.json examples\research-policies\situated.json --trial-tokens 16000000 --trial-judge-calls 400000 --evaluations 4 --attempts 8
```

- **Mutador:** el motor evolutivo propone variantes de la política con el modelo `AGENT_LLM` del lanzador.
- **Medida:** cada variante se mide con ensayos completos en los casos de desarrollo. Cada evaluación son cinco runs
  del junior: conviene empezar con muy pocas.
- **Fondo de los ensayos:** `--trial-tokens` y `--trial-judge-calls` son lo que pueden gastar en total. Cada ensayo
  reserva su máximo (`--max-tokens` y `--max-judge-calls` del junior) antes de lanzarse. Una evaluación son cinco
  ensayos, 4 000 000 tokens y 100 000 llamadas reservados, así que estos fondos alcanzan para cuatro. `--tokens` sólo
  limita al mutador.
- **Evaluación incompleta:** si el fondo no alcanza para todos sus ensayos, la evaluación queda incompleta, sin
  calidad, y no compite con las completas. La búsqueda se detiene ahí.
- **Vuelta atrás:** cada búsqueda tiene su propio registro en `runs/meta/meta-pilot/searches/`, que nunca se
  sobrescribe. Se continúa con `--resume <registro>`, que escribe uno nuevo, y sólo con la misma configuración del
  lanzador: con otro modelo, sus medidas no valen y se rechaza.

## 4. Lectura sin gasto

```powershell
.\lab_two_tier_reasoning.ps1 meta index
.\lab_two_tier_reasoning.ps1 meta inspect examples\research-policies\situated.json ..\runs\batches\c302nav-senior-3\senior-real-s1.json
```

- **`index`** escribe el índice del corpus, con sus linajes, en `runs/meta/corpus.json`.
- **`inspect`** dice qué habría aconsejado la política en cada punto de un run ya hecho. Inspecciona decisiones, no
  mide lo que habría pasado.

**Qué dijo la inspección al preparar el piloto.** La candidata se leyó contra el run de c302 con senior y contra la
rama B de 3SUM:
- **Dónde habría intervenido:** en el run de c302, al principio de las rondas 2 y 7, porque el junior sólo miraba
  («predict»), y en las rondas 3 y 6, porque el modelo no se sostenía en ningún lugar («discriminate»).
- **Por qué no repite:** su primera versión habría repetido «discriminate» en todas las rondas. Ahora no repite un
  consejo en dos rondas.
- **El recordatorio** habría hablado tres veces en ese mismo run.
