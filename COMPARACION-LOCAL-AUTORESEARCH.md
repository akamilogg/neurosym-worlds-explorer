# Comparación con local-autoresearch

Revisión del 28/10/2026. Fuente externa: [conglu1997/local-autoresearch, revisión 8ded3cc](https://github.com/conglu1997/local-autoresearch/tree/8ded3cc30bcf443f96e3c73939a106a906bf1871).
Referencia local: `cd419d0` al cerrar la revisión, iniciada sobre `2897d37`. Se leyeron código, pruebas y documentación; no se ejecutaron sus
candidatos, pruebas ni inferencias. Los resultados externos que se citan son los publicados por su autor, no reproducciones propias.

Durante la revisión se incorporó M1 de metapolítica en `cd419d0`. Se comprobó la presencia del módulo y su integración,
sin realizar aquí una auditoría de cumplimiento ni nuevos ensayos de mejora aprendida. M2 y M3 siguen pendientes;
el catálogo y su selector dinámico son una extensión propuesta.

## 1. Conclusión

La alineación es sustancial: un LLM propone un programa, un entorno independiente lo ejecuta y mide, la búsqueda usa
esa evidencia y conserva sus intentos. local-autoresearch es una realización deliberadamente pequeña y concreta de
esa idea. Dentro de este repo, su equivalente más directo es **el mundo de artefactos con búsqueda evolutiva**.

Su existencia y sus resultados apoyan que ese mecanismo puede producir mejoras útiles. No prueban que nuestras capas
adicionales mejoren el resultado, que el método sustituya cualquier capacidad del modelo ni que se haya demostrado
creatividad fuera de su distribución. Esas afirmaciones necesitan comparar los mecanismos sobre las mismas tareas.

## 2. Coincidencias y diferencias reales

| Aspecto | local-autoresearch | Este arnés |
|---|---|---|
| Unidad investigada | Un programa `solve(problem, seed, budget)` para una tarea y una entrada definida. | Modelos de mundos desconocidos y artefactos ejecutables; en artefactos distingue el producto del modelo de su comportamiento. |
| Interacción | El modelo recibe encargo, programa de partida, resultados recientes y el intento anterior cuando procede. Devuelve código completo. | El investigador elige intervenciones, inspecciones, instrumentos, pruebas y memoria; puede delegar. El mutador evolutivo es un componente más acotado. |
| Selección | El serial conserva mejoras; el equipo inicia cada petición desde el mejor programa global. | Población con desarrollo, reparación, élites, recombinación, reinicios y archivo opcional. |
| Dirección | Cuatro encargos fijos en rotación por trabajador. | Operadores de evolución y orientación de senior/operador; política individual M1 incorporada, catálogo y selector aprendidos propuestos. |
| Evaluación | Validez y puntuación de la solución; en bike hay partición temporal y test final. | Corrección, calidad y aceptación separadas; familias, regresiones, confirmación y medidas de incertidumbre según el mundo. |
| Coordinación | Trabajadores asíncronos comparten el mejor programa; cada uno conserva sus últimos resultados. | Equipos con intercambio, delegaciones, senior, mensajes y actores de mundo vivo; no todo equivale a una población evolutiva compartida. |
| Reconstrucción | Solicitudes, respuestas y streams, código, resultados, decisiones y verificadores offline. | Diarios, contenidos y cambios de artefactos, llamadas, acciones, búsquedas, reservas y paquetes con reconstrucción. |
| Ejecución de candidatos | Aislamiento del SO y límites de CPU en macOS. | El backend de artefactos presente es `processSandbox`, marcado `isolated: false`; CPU y pico de memoria quedan como `null`. |

Fuentes externas: [bucle serial](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/research.py),
[contexto del modelo](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/runner/core.py),
[selección del equipo](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/runner/teams.py),
[evaluador](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/runner/evaluate.py).
Referencias locales: [selección evolutiva](lib/src/learn/evolve/policy.ts), [contextos](lib/src/learn/evolve/engine.ts),
[tareas de artefactos](lib/src/artifacts/task.ts), [equipos](lib/src/orchestra/team.ts), [sandbox](lib/src/artifacts/sandbox.ts).

### Caminos con pasos intermedios

En `Team.select` el padre siempre es `self.best.attempt`. Conservar un intento inferior en el registro, o mostrarlo en
el siguiente prompt, no le concede una línea de desarrollo. Nuestro motor sí reserva intentos a candidatos correctos
que aún no ganan. Eso responde directamente al problema de perder una idea que necesita varias revisiones antes de
ser competitiva. Es una diferencia de mecanismo comprobable, no evidencia de superioridad de resultados.

Tampoco hay allí un catálogo aprendido: `(agent + replicate + count) % 4` elige el encargo. Es una referencia sencilla
para contrastar un selector situado. Nuestro perfil evolutivo también tiene decisiones fijadas por el diseñador;
disponer de operadores y reacción al atasco no equivale a haber aprendido esa política.

### Registro y comprobación

Su trazabilidad es sustancial: los verificadores reconstruyen decisiones, recomputan puntuaciones desde soluciones
guardadas y comprueban respuestas contra sus streams. El verificador paralelo reconstruye las admisiones y elecciones.
No sería correcto describirlo como un sistema que sólo guarda al ganador. El nuestro también separa reproducir la
evidencia de volver a ejecutar el experimento, y añade las interacciones con el mundo y los recursos delegados.
[Verificador serial](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/tools/verify_run.py),
[paralelo](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/tools/verify_parallel.py),
[reconstrucción evolutiva local](lib/src/learn/evolve/verify.ts).

En el serial externo, una interrupción aparta el intento incompleto y vuelve a ejecutarlo al reanudar. Nuestra búsqueda
registra intención y recibo y conserva el gasto incierto sin reenviar automáticamente la llamada. Son garantías distintas;
el replay externo no implica nuestra semántica de recuperación.

## 3. Qué muestran sus experimentos

Los ejemplos publicados mejoran packing de círculos, planificación y predicción de demanda. Son problemas conocidos
con encargos informativos; por ejemplo, el prompt de bike explica la partición temporal y propone familias de modelos.
Eso es apropiado para optimización práctica, pero no es la misma condición que descubrir un mundo oculto sin esas pistas.
[Encargo de bike](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/tasks/bike/program.md).

Tres observaciones especialmente útiles:

- **Transferencia:** bike reduce RMSLE un 30,81 % en validación y un 9,08 % en el test posterior, tras reentrenar sin
  modificar ambos programas. El mejor aparece en el intento 34; los 66 restantes no lo superan. Hay mejora transferida,
  y también una meseta prolongada. [Run de bike](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/examples/2026-10-21-bike/README.md).
- **Tiempo frente a intentos:** ocho trabajadores hacen aproximadamente 2–2,5 veces más experimentos válidos por hora
  y ganan 5 de 6 parejas. A igual número de experimentos, uno gana en scheduling y bike. Las pequeñas ablaciones de
  compartir el mejor y rotar encargos no son concluyentes. No se ha aislado una ventaja de coordinación o de creatividad.
  [Comparación publicada](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/docs/eight-worker-results.md).
- **Qué significa aceptar:** el ganador de circle pasa la tolerancia numérica pero falla la comprobación racional exacta
  de sus coordenadas. El autor lo declara y distingue la mejor alternativa exactamente factible. También identifica
  que una mejora procedía de la inicialización, no de la rotación que describía el modelo. Esto refuerza separar relato,
  evidencia y criterio de aceptación. [Run de circle](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/examples/2026-10-20-final/README.md).

No hacen falta nuevas barreras metodológicas universales para incorporar esas lecciones: cada tarea debe definir qué
acepta y conservar evidencia suficiente para comprobarlo. Un cambio del criterio abre otra condición.

## 4. Qué incorporaría

### Primero: simplificar la entrada de problemas y aportar tareas resolubles

Su receta de entrada tiene tres piezas: problema/checker, baseline y encargo. Este repo ya tiene `ArtifactTask`, pero
la selección de tareas en `worlds/artifacts/lab.ts` sigue registrada a mano. Añadiría una plantilla o comando de alta
que cree un adaptador, una base ejecutable, familias y una comprobación local mínima. No un segundo protocolo de tareas.
[Guía externa](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/docs/add-a-task.md).

Empezaría por **planificación de trabajos**: salida verificable, ejecución barata y familias con distintas máquinas,
trabajos y duraciones. Permite contrastar método y evolución donde hay mejoras alcanzables, además de ThreeSum.
Después, una tarea de **predicción con partición temporal** permite investigar programas que entrenan modelos pequeños.
Se reutilizan oráculos y familias; no se entregan resultados reservados al mutador.

### Segundo: un backend aislado y recursos medidos

Tomaría como referencia el contrato de ejecución: permisos de SO, límites efectivos de CPU, cancelación de procesos y
medición separada de tiempo y memoria. Su implementación concreta depende de macOS y no es trasladable directamente
al entorno Windows del proyecto. El puerto útil es otro backend de `Sandbox`, no afirmar que un directorio temporal
o un entorno vacío ya aíslan. Es una carencia de implementación actual, no del contrato abstracto.

Para inferencia local también interesa observar ocupación, latencia, memoria y trabajo evaluado por unidad de tiempo.
Su launcher coordina slots de llama.cpp, fija versiones de runtime/modelo y registra memoria y swap. Se puede tomar
esa disciplina sin introducir Flint como dependencia ni modificar la selección científica.
[Launcher](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/tools/llama_cpp.py).

### Tercero: una referencia sencilla para el catálogo de métodos

Compararía política fija, rotación fija y selección dinámica con el mismo junior y tareas. Las cuatro orientaciones
externas ofrecen una referencia concreta; nuestra contribución por comprobar es aprender **cuándo** y **por qué** usar
un procedimiento, conservar especialistas y evolucionar el repertorio. El catálogo inicial está en
[CATALOGO-METAPOLITICAS-INVESTIGACION](CATALOGO-METAPOLITICAS-INVESTIGACION.md).

### Mejoras menores que sí aportan

- Una huella estructural opcional por lenguaje para informar repeticiones de sintaxis: allí eliminan comentarios y
  docstrings del AST. No certifica equivalencia semántica; quitar docstrings incluso puede cambiar programas que los
  inspeccionan. Conservaría el hash completo como identidad y no omitiría evaluaciones automáticamente por esa huella.
  [Implementación](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/runner/search.py).
- Exportación para compartir con transformaciones declaradas, detección de credenciales y hashes de origen y exportación.
  Complementaría el paquete íntegro; la copia redactada no se presentaría como replay idéntico sin comprobar sus límites.
  [Exportador](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/tools/export_run.py).

No propondría otra consola: la vista escalada y su exportación HTML ya están implementadas aquí. Lo que tomaría de sus
ejemplos es la lectura inmediata: problema, punto de partida, cambios medidos y límites del resultado. Tampoco sustituiría
nuestra población por compartir siempre el mejor: perderíamos precisamente las oportunidades de desarrollar alternativas.

## 5. Qué se refuerza y qué queda por demostrar

Se refuerzan la búsqueda sobre programas, la evaluación independiente, el registro completo y la utilidad de modelos
locales dentro de un bucle de experimentos. Nuestro proyecto extiende ese enfoque hacia decisiones experimentales,
mundos desconocidos, investigación compartida y método investigable. Esa extensión ofrece posibilidades; también exige
probar que cada componente justifica su complejidad.

La comparación más informativa sería portar una tarea acotada, mantener su evaluador y comparar una búsqueda codiciosa
sencilla con nuestra evolución, y después con políticas de investigación. Se separan mejora por intento, por recursos
y por tiempo. Los resultados pueden justificar conservar un mecanismo complejo o usar el sencillo cuando baste.
