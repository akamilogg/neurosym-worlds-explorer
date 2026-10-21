# 3SUM estancado: ¿delega, y abre caminos distintos?

Desde `lib/`, con la configuración de modelos habitual (el mundo de artefactos no necesita servicio):

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.artifacts-threesum-delegation.json
```

Dos **continuaciones** de `artifacts-threesum-subquadratic-7`. Ese run llegó a O(n²) en 12 rondas y no propuso ninguna
hipótesis que intentara bajar de ahí. Las dos continuaciones parten de esa trayectoria estancada (sin empezar de cero) y
tienen esto en común:
- 8 rondas más, hasta 20;
- el mismo senior, con 8 órdenes;
- 4 millones de tokens del junior;
- un **fondo de delegación** que se abre en sus rondas nuevas, nunca en la historia que repiten (SPEC-DELEGACION-
  INVESTIGACIONES §10.6): 900k tokens, 300k y 3 rondas por rama por defecto, y como mucho 6 rondas. Lo comparten el junior
  y el senior.

La diferencia entre las dos:

| Run | Qué pregunta |
| --- | --- |
| `threesum-stalled-free` | Nadie le dice nada del fondo. **¿Decide delegar cuando su investigación deja de avanzar?** |
| `threesum-stalled-invited` | Un mensaje del operador en su primera ronda nueva le invita a delegar un examen de sus propios supuestos. No nombra ningún algoritmo ni ninguna familia: queremos ver qué caminos abre, no si desarrolla los nuestros. Ese mensaje cuenta como ayuda. **Cuando delega, ¿la rama aporta una dirección distinta y fundamentada? ¿El padre la contrasta y decide?** |

Si el primero no pide ninguna rama, habremos aprendido algo sobre la primera pregunta. El segundo existe para que la
segunda pregunta se pruebe de todos modos.

**Qué se mira** (es un piloto: una semilla, sin conclusiones):
- **Si delega y cuándo:** en qué ronda, tras qué señales de estancamiento, y quién lo hace (junior o senior).
- **El encargo:** si cuestiona un supuesto o pide más de lo mismo.
- **El resultado de la rama** (`research_result`): el mecanismo, sus condiciones de aplicación, un contraste inicial con
  evidencia propia y las alternativas descartadas. Una lista de ideas no basta. Concluir que no hay una dirección
  defendible también es un resultado.
- **Qué hace el padre después:** si lo lee, lo contrasta con sus instrumentos y cambia de dirección o la descarta con
  razones. Lo que importa es la solidez del método, no ganar.
- **El coste:** directo, delegado y retenido, que van aparte en K1.

**Límites de la prueba:**
- **El veredicto de `threesum` compara con la base cúbica** en tamaños de unos 300–600 elementos. Demuestra una mejora
  práctica, pero no distingue lo subcuadrático de lo cuadrático. Esta prueba evalúa el comportamiento exploratorio. Para
  sostener una mejora de complejidad harían falta un análisis del algoritmo y experimentos de escalado frente a una
  referencia cuadrática, que serían un cambio de la tarea, no del arnés.
- **La continuación repite los argumentos del run original.** Eso incluye su `--experience` en modo `meta` y su tarea, que
  dice que existe una solución algo por debajo de O(n²). Cambiarlos haría divergir la historia que repite.
