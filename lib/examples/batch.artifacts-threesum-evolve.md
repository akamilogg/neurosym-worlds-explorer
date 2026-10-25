# 3SUM con búsqueda evolutiva (SPEC-DELEGACION-EVOLUTIVA H3)

Desde `lib/`, con la configuración de modelos habitual (el mundo de artefactos no necesita servicio):

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.artifacts-threesum-evolve.json
```

Dos runs nuevos de `threesum-subquadratic@1` desde su base cuadrática: la tarea pasa sólo si la complejidad baja de
O(n²) (SPEC-MUNDO-ARTEFACTOS §18.12). Son los mismos argumentos que `batch.artifacts-threesum-delegation.json`, más el
modo evolutivo, para poder compararlos con la delegación normal:
- 16 rondas, un senior con 8 órdenes y 4 millones de tokens del junior;
- un fondo de 1,2 millones para ramas, con 600k por rama;
- una rama puede ser una investigación normal o una **búsqueda evolutiva** de hasta 30 evaluaciones, con 1 workload por
  tamaño de la escalera en cada evaluación;
- de los 600k de una rama evolutiva, el 75 % es para la búsqueda y el 25 % queda protegido para la consolidación;
- la búsqueda se limita a la vez por evaluaciones, intentos (3 por evaluación) y tokens;
- lo exportado se confirma con workloads nuevos.

| Run | Qué pregunta |
| --- | --- |
| `threesum-evolve-free` | Nadie le dice nada del modo. ¿Lo usa? Y si lo usa, ¿la búsqueda le deja algo utilizable? |
| `threesum-evolve-invited` | Un mensaje del operador en la ronda 6 le invita a delegar una búsqueda evolutiva desde su versión actual, sin nombrar ningún algoritmo. Ese mensaje cuenta como ayuda. ¿Qué le dan los candidatos, los reinicios y la consolidación? ¿Los adopta, los prueba o los descarta con razones? |

**Qué se mira en cada rama evolutiva:**

| Pregunta | Dónde se ve |
| --- | --- |
| ¿Qué padres recibieron trabajo? | `.search.jsonl` (`attempt_planned`) y `decisions` del manifiesto |
| ¿Cambió las propuestas el feedback? | El contexto de cada intento frente a lo que propuso |
| ¿Qué produjeron los reinicios? | Los intentos `restart` y sus linajes |
| ¿Abrió otra dirección o son variaciones de lo mismo? | Los candidatos y sus raíces de linaje |
| ¿Qué dijo la consolidación? | `.consolidation.json` |
| ¿Qué hizo el padre con el resultado? | El diario del padre: si adoptó un candidato con un cambio y lo comprobó |

Si sólo aparecen variaciones equivalentes, hay que distinguir antes de gastar más dónde falla: la generación, el reparto
de oportunidades, la medición o la ejecución. Que se cumpla el protocolo no acredita que la búsqueda haya abierto otra
dirección.

**Coste:** una evaluación de crecimiento ejecuta la referencia y el candidato intercalados. Con un workload por tamaño se
reduce el tiempo, pero el intervalo es más ancho. Los segundos de máquina no tienen límite propio en esta entrega; lo
acotan las evaluaciones y `--max-minutes` del run.
