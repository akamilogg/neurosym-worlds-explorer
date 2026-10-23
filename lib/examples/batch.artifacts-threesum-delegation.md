# 3SUM por debajo de O(n²): ¿delega al estancarse, y abre caminos distintos?

Desde `lib/`, con la configuración de modelos habitual (el mundo de artefactos no necesita servicio):

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.artifacts-threesum-delegation.json
```

## La tarea: `threesum-subquadratic@1`

Pasar ya no significa ganar a la base cúbica, sino **tener una complejidad menor que la cuadrática**:

- **La base, que es también la referencia, es cuadrática:** ordena los números y, para cada uno, cierra dos punteros. El
  investigador empieza donde se estancaron los runs anteriores (`artifacts-threesum-subquadratic-*`).
- **Se juzga el crecimiento, no el tamaño** (`Objective.growth`, en `lib/src/artifacts/task.ts`):
  - cada lugar es una escalera de tamaños: n = 2000, 4000 y 8000, más n = 3;
  - lo que cuesta n = 3 es el coste fijo de cada versión (arrancar Python, leer la entrada), y se descuenta antes de nada;
  - con lo que queda se toma la pendiente log-log del tiempo de la versión entre el de la referencia;
  - una versión pasa si esa pendiente es menor que −0,05, con un 90 % de confianza.

  Por eso una constante menor, un coste fijo distinto o un truco para rangos acotados nunca cuentan como crecimiento.
- **El intervalo recoge todo el ruido medido:** remuestrea los workloads de cada tamaño y las repeticiones de cada run. La
  base contra sí misma da una pendiente de −0,002, con un intervalo de −0,028 a +0,022.
- **Si el trabajo no destaca sobre el coste fijo,** el crecimiento no se lee: el veredicto lo dice, en lugar de devolver
  una pendiente hecha de ruido.
- **Las entradas:**
  - los valores están en ±1e12, para que no quepa ninguna tabla ni transformada sobre el rango;
  - la familia no tiene ternas, así que el programa hace todo el trabajo (comprobado: 0 de 40 tienen terna por azar);
  - la mitad de los workloads del laboratorio tienen una terna plantada, para que una respuesta fija no pase;
  - los ciegos la tienen al final.
- **Coste:** un check con 2 workloads por tamaño tarda alrededor de un minuto. La referencia tarda unos 4 s en n = 8000, y
  una versión cúbica se pasa del tiempo límite.

`threesum@1` queda intacta, así que los runs anteriores siguen siendo reproducibles.

## Los dos runs

Son runs nuevos, sin `--experience` (en runs anteriores le comía rondas al junior). Comparten:
- 16 rondas;
- un senior con 8 órdenes;
- 4 millones de tokens del junior;
- un fondo de delegación de 900k tokens, compartido por junior y senior, con 300k y 3 rondas por rama por defecto y como
  mucho 6 rondas.

La tarea no da pistas sobre el algoritmo.

| Run | Qué pregunta |
| --- | --- |
| `threesum-stalled-free` | Nadie le dice nada del fondo. **¿Decide delegar cuando su investigación deja de avanzar?** |
| `threesum-stalled-invited` | Un mensaje del operador en la ronda 6 le invita a delegar un examen de sus propios supuestos, sin nombrar ningún algoritmo ni familia. Ese mensaje cuenta como ayuda. **Cuando delega, ¿la rama aporta una dirección distinta y fundamentada? ¿El padre la contrasta y decide?** |

Si el primero no pide ninguna rama, habremos aprendido algo sobre la primera pregunta. El segundo existe para que la
segunda se pruebe de todos modos.

**Qué se mira** (es un piloto: una semilla, sin conclusiones):
- **Si delega y cuándo:** en qué ronda, tras qué señales de estancamiento, y quién lo hace (junior o senior).
- **El encargo:** si cuestiona un supuesto o pide más de lo mismo.
- **El resultado de la rama** (`research_result`): el mecanismo, sus condiciones de aplicación, un contraste inicial con
  evidencia propia y las alternativas descartadas. Una lista de ideas no basta. Concluir que no hay una dirección
  defendible también es un resultado.
- **Qué hace el padre después:** si lo lee, lo contrasta con sus runs y cambia de dirección o la descarta con razones. Lo
  que importa es la solidez del método, no ganar.
- **El coste:** directo, delegado y retenido, que van aparte en K1.

**Límite:** el tiempo sólo revela la complejidad en el régimen que mide. Una mejora de factores logarítmicos (los
algoritmos subcuadráticos conocidos para 3SUM lo son) puede quedar por debajo del margen en una escalera de 2000 a 8000.
Ese veredicto exige una mejora de crecimiento visible, no la demostración de una cota asintótica.
