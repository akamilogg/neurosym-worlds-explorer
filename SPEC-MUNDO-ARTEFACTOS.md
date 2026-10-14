# SPEC · El mundo de artefactos: construir y optimizar con método científico

Estado: en construcción (14/10/2026). Idea del autor. Hecho: §18.

## 1. De dónde sale

El arnés se construyó para entender entornos desconocidos. Tiene rasgos que interesan fuera de la ciencia:
- **Deja evidencia de cada acción:** qué hizo, por qué, cómo respondió el entorno y qué creencia sostenía.
- **Puede volver atrás con inteligencia:** si cae una creencia, no basta con volver a un commit anterior; hay que
  descartar lo que se apoyaba en ella.
- **Atiende por observaciones:** el investigador elige qué medir y reduce un entorno enorme a las pocas magnitudes que
  importan.
- **Protege contra engañarse:** casos nuevos en cada check, validación en otras variantes, confirmación a ciegas y
  predicciones prerregistradas.

El autor quiere usarlo para tareas de código y de optimización de automatizaciones: encontrar una forma más rápida de
completar un flujo, por ejemplo. Para un sistema evolutivo son buenas propiedades. **La dificultad:** el arnés optimiza una
respuesta, un modelo de un mundo fijo, mientras que en una tarea de código lo que se quiere es el propio artefacto.

## 2. La idea: el artefacto es el mundo, y el modelo es de su comportamiento

Se conservan las dos capas del arnés, cambiando dónde está cada cosa:
- **El mundo es el artefacto en ejecución,** y es **modificable:** cambiarlo es una intervención, como hoy `act` quita o
  escala conexiones del circuito de c302.
- **La respuesta tiene dos partes:**
  1. **El artefacto:** la versión del programa o del flujo que se entrega. Es el producto.
  2. **El modelo de su comportamiento:** qué determina su rendimiento y su corrección, y qué efecto tendrá cada cambio.
     Por ejemplo: "el 70 % del tiempo se va en la deduplicación; con un índice por clave baja al menos un 20 % en cargas con
     muchas claves repetidas, y no cambia en las demás". Es la comprensión que guía la búsqueda.
- **Se juzgan las dos.** El artefacto, por su corrección y su mejora en cargas nuevas. El modelo, por si sus predicciones
  sobre el efecto de los cambios se cumplen.

Así la búsqueda es evolutiva pero no ciega. Cada variante es una mutación guiada por una hipótesis, y la hipótesis se
corrige con lo que pasa.

## 3. Principios

- **Corrección antes que rendimiento.** Una variante más rápida y rota no existe: el oráculo de corrección decide
  primero.
- **Sin sobreajuste al benchmark.** Igual que en los mundos de leyes: casos nuevos en cada check, familias de carga
  distintas para validar y cargas que nadie ha visto para confirmar.
- **Medir con ruido.** Los tiempos varían: el veredicto repite ejecuciones y compara con margen, nunca con una sola
  medida.
- **Toda acción con su razón.** Cada cambio del artefacto va con la hipótesis que lo motiva y su predicción, registradas
  antes de medir.
- **Aislamiento.** El artefacto se ejecuta en un sandbox, sobre réplicas y nunca sobre sistemas reales. Sólo sale a la red
  si la tarea lo declara y hacia los destinos que declara.
- **Las reglas de siempre:** el entorno da veredictos y primitivas, no análisis hechos (sin investigación precocinada);
  el investigador mide el resto con sus instrumentos.

## 4. La tarea: qué declara un mundo de artefactos

Cada tarea es un laboratorio, con la interfaz común (`Lab`), y declara:
- **El artefacto base:** el código de partida (un repositorio o un directorio), su punto de entrada y cómo se construye.
- **El oráculo de corrección:** cómo se decide que una salida es correcta. Puede ser la igualdad con la salida de la
  versión de referencia, unos tests, unas propiedades (por ejemplo, "ordenada y con los mismos elementos") o una
  combinación.
- **El generador de cargas:** las entradas con que se ejecuta, por familias (tamaños, distribuciones, proporción de claves
  repetidas, casos límite), con semilla. Una familia es el equivalente a un lugar.
- **Las métricas:** qué se optimiza (tiempo de pared, CPU, memoria máxima, número de llamadas a una API, coste) y en qué
  dirección. Una principal, y el resto como restricciones (por ejemplo, "la memoria no puede crecer más de un 10 %").
- **El margen de mejora:** cuánto tiene que mejorar una variante para contar como mejor, con qué número de repeticiones y
  con qué criterio estadístico (§8).
- **El sandbox:** lenguaje y runtime, límites de CPU, memoria y tiempo, ficheros accesibles y red permitida.

## 5. El artefacto, versionado

- **Cada versión es un estado del mundo,** identificada por el hash de su contenido. El diario guarda el árbol de
  versiones: de qué versión sale cada una y con qué cambio.
- **Un cambio es un parche** sobre una versión existente. Puede ser un diff, la sustitución de un fichero o de una
  función. Se aplica en el sandbox, se construye, y si no compila o no construye se rechaza, diciendo por qué.
- **No hay una "versión actual" impuesta.** El investigador elige de qué versión parte cada cambio. Volver atrás es partir
  de una versión anterior, y nunca se pierde nada.

## 6. Los actos

Lo que hoy es `act` se divide en primitivas del mundo:

| Acto | Qué hace | Coste |
|---|---|---|
| `change` | aplica un parche a una versión y crea otra nueva (construida, no ejecutada) | un acto |
| `run` | ejecuta una versión sobre cargas de las familias de sus laboratorios, con repeticiones; devuelve salidas, corrección por caso y métricas | uno por lote de ejecuciones, con tope de casos |
| `profile` | lo mismo con instrumentación del runtime: perfil de CPU, trazas, asignaciones de memoria | un acto (más caro) |
| `diff` / `view` | lee el código de una versión, o la diferencia entre dos | gratis |

Los resultados de `run` y `profile` son los **episodios** de este mundo. Se guardan enteros y los leen `view`, `measure`,
`table` y los instrumentos propios.

## 7. El percepto y las observaciones

**Lo que se sabe antes de ejecutar y lo que la ejecución revela van separados,** como en los mundos de leyes, donde el
percepto de un punto nunca contiene lo que hay que predecir en él (corregido tras una revisión externa, 14/10/2026: la
primera versión daba al modelo las métricas de la misma ejecución que debía predecir, y bastaba con copiarlas).

**El percepto de un punto** (una versión sobre una carga) es sólo lo disponible **antes** de ejecutarla:
- la carga: su familia, sus parámetros y la propia entrada, o un resumen que la tarea declare;
- la versión: su hash, su código y sus cambios respecto a la de partida.

**Lo que salió** (`came`, como en los demás mundos) es lo que la ejecución revela **después**, y nunca entra en el
percepto del mismo punto:
- las métricas medidas;
- la corrección del caso;
- el perfil, si lo hubo.

Sus observaciones extraen del percepto las magnitudes que, según su modelo, deciden el rendimiento: el tamaño de la
entrada, la proporción de repetidos, si la versión usa un índice. La salida del modelo predice la métrica de esa
ejecución. Lo que aprendió de perfiles y métricas de **otras** ejecuciones (sus episodios) lo lleva a su modelo por la vía
de siempre: sus creencias, sus documentos y el código que escribe, no leyéndolo en el punto que predice.

Así el modelo es comprobable como en un mundo de leyes: **predice el rendimiento de una versión en una carga.** Y es útil:
sirve para elegir qué cambio probar antes de gastar ejecuciones.

## 8. El veredicto

Dos veredictos, ambos del entorno y ambos sólo "se sostiene o no", sin métrica añadida para el investigador.

**El del artefacto,** con el protocolo de siempre:
- **Check:** la versión propuesta se ejecuta sobre cargas nuevas de las familias de sus laboratorios, con repeticiones.
  - Se sostiene si es **correcta en todos los casos** y mejora la métrica principal sobre la referencia por encima del
    margen, con el criterio estadístico de la tarea. Por ejemplo, intervalo de confianza de la mediana del cociente de
    tiempos por debajo de 1 − margen.
  - Las restricciones no pueden empeorar más de lo permitido.
- **Regresión emparejada:** los casos del check anterior se vuelven a ejecutar con la versión nueva, y no puede ir peor.
- **Validación:** en las familias de carga que no ha visto. Una familia donde no se sostiene pasa a ser laboratorio.
- **Confirmación a ciegas:** en cargas que nadie ha visto, generadas de familias reservadas.

**El del modelo,** con las pruebas propias:
- Antes de medir, el investigador registra qué predice su modelo de un cambio (por ejemplo, "la versión nueva baja al
  menos un 20 % en la familia de claves repetidas, y no más de un 5 % en las otras"), frente a un rival: otro modelo, o
  "el cambio no influye".
- El entorno ejecuta y responde si se cumplió. Una predicción que falla queda como contraejemplo abierto.
- `--own-tests N` exige N predicciones severas cumplidas antes de la confirmación a ciegas, como ya existe.

**La aceptación** necesita las dos cosas: un artefacto confirmado a ciegas, y un modelo cuyas predicciones prerregistradas
se cumplieron. Un artefacto que mejora sin que nadie sepa por qué se acepta como artefacto, pero el finding lo marca como
**no explicado**.

## 9. Volver atrás por creencias

El cuaderno ya guarda creencias con su evidencia. Aquí se añade un vínculo:
- **Cada cambio declara en qué creencias se apoya:** `"because": ["<belief id>", ...]`.
- **Cuando una creencia cae** (se descarta o la refuta una prueba), el entorno lista las versiones cuyos cambios se
  apoyaban en ella, y si siguen en la línea de la versión vigente. Es un hecho del registro, no un análisis: decidir qué
  revertir sigue siendo del investigador.
- **El senior lo revisa:** un cambio que sobrevive a la caída de su razón es un cambio sin justificar.

Así, volver atrás no es "ir al commit anterior": es quitar justo lo que dependía de lo que resultó falso y conservar lo
demás.

## 10. El sandbox

**Sin dependencias** (regla del autor, 14/10/2026): nada de Docker ni de otro software que el usuario tenga que
instalar o arrancar. El sandbox es una interfaz, y hoy tiene un backend de procesos locales:
- **Un proceso por ejecución,** con el runtime declarado (Node, Python, una shell), en un directorio de trabajo nuevo,
  con la versión del artefacto copiada junto a la carga.
- **Un entorno vacío:** sólo lo que encuentra el runtime, y ninguna clave ni variable del anfitrión.
- **Límites:** tiempo de pared (el proceso se mata al pasarlo) y tamaño de lo que escribe en su salida.
- **Ruido controlado:** misma máquina y ejecuciones alternadas (referencia y variante intercaladas), para que la deriva
  de la máquina no se confunda con mejora. La tarea declara cuántas repeticiones.

**Lo que este backend NO hace:** aislar. El proceso puede llegar a la red y a los archivos que el usuario puede, y no
limita memoria ni CPU. Por eso:
- **Sólo para artefactos de confianza:** los del propio operador, o código del investigador sobre tareas suyas. Cada
  ejecución dice que no estaba aislada, y el finding lo recoge.
- **Las automatizaciones que llaman a APIs** se ejecutan contra réplicas o simuladores declarados en la tarea. Lo
  garantiza la tarea (sus direcciones), no el sandbox.
- **Un backend que aísle** puede añadirse después sin cambiar nada de lo que ejecuta artefactos, siempre que no imponga
  dependencias. Queda como pregunta abierta (§16).

## 11. Repetir y reanudar

- **El artefacto** se reconstruye exactamente de su árbol de versiones: cada versión es su base más su parche, y se
  identifica por hash.
- **Las mediciones tienen ruido:** volver a ejecutarlas daría otros números. Por eso se graban como respuestas del entorno
  (canal `env`), igual que hoy las simulaciones de c302, y al repetir un run se sirven del registro.
- **Los instrumentos propios** se vuelven a ejecutar, porque son deterministas sobre los episodios grabados.

## 12. En paralelo: población de variantes

La investigación en paralelo (SPEC-INVESTIGACION-PARALELA) da el lado evolutivo:
- **Varios equipos** parten de la misma base y exploran hipótesis distintas: ramas.
- **El tablón** comparte hallazgos con su evidencia: "la deduplicación domina en cargas repetidas".
- **Las confirmaciones a ciegas son del equipo,** y no se gastan dos veces en la misma carga.
- **Combinar ramas:** un equipo puede partir de la versión de otro y declarar en qué creencias de ese otro se apoya. Así
  la combinación queda justificada y deshacerla es posible.

## 13. Qué se reutiliza y qué hay que construir

**Se reutiliza tal cual:**
- el investigador asistido y el senior;
- el cuaderno, los documentos propios y las preguntas abiertas;
- el protocolo de check, familia y ciegas;
- las pruebas propias y el estado de los experimentos;
- los instrumentos propios, para analizar perfiles y tiempos;
- la memoria selectiva y la experiencia entre runs;
- la repetición y la reanudación, los presupuestos con cierre, los lotes emparejados y los equipos;
- la auditoría del método y el registro de anomalías del instrumento.

**Hay que construir:**
1. **El sandbox de ejecución:** procesos locales sin dependencias, runtimes y límites (§10).
2. **El artefacto versionado:** árbol de versiones por hash, parches, construcción y `diff`/`view` de código.
3. **El objetivo "optimizar":** veredicto con oráculo de corrección, repeticiones, criterio estadístico y restricciones.
4. **Los actos** `change`, `run` y `profile`, y su percepto.
5. **El vínculo cambio → creencias** y la lista de versiones afectadas cuando cae una.
6. **La respuesta doble** en el finding: el artefacto aceptado, su modelo, y si está explicado.

## 14. El primer caso

Pequeño, local y sin red, para probar el mundo antes de llevarlo a automatizaciones reales:
- **Artefacto:** un script de procesamiento de datos, escrito a propósito con ineficiencias reales y variadas: lectura
  completa en memoria, deduplicación cuadrática, ordenaciones repetidas, expresiones regulares recompiladas.
- **Oráculo:** igualdad con la salida de la versión de referencia, tras normalizar el orden si la tarea lo permite.
- **Familias de carga:** tamaño (pequeño, mediano, grande), proporción de claves repetidas y anchura de registro. Una
  familia queda reservada para la confirmación a ciegas.
- **Métricas:** tiempo de pared (principal) y memoria máxima (restricción).
- **Lo que esperamos ver:**
  - que el modelo identifique qué ineficiencia domina en cada familia;
  - que prediga el efecto de cada cambio antes de medirlo;
  - que no acepte mejoras que sólo lo son en la familia donde se probaron.

Después, una automatización real con sus APIs simuladas.

## 15. Medidas y evaluación

- **Para el operador:**
  - mejora confirmada a ciegas y su intervalo;
  - versiones creadas;
  - ejecuciones gastadas;
  - predicciones registradas, cumplidas y fallidas;
  - cambios revertidos al caer su creencia;
  - tokens.
- **Comparaciones** emparejadas, con la misma tarea y el mismo presupuesto:
  - frente a un agente de código directo, sin protocolo;
  - frente a una búsqueda ciega, con mutaciones sin modelo;
  - con y sin el requisito de predicciones (`--own-tests`).
- **Qué sostendría la idea:** mejoras que se confirman a ciegas cuando las del agente directo no, o el mismo resultado con
  menos ejecuciones gracias al modelo.

## 16. Riesgos y preguntas abiertas

- **El coste:** es lento y caro comparado con un agente directo. Tiene sentido cuando equivocarse sale caro, o cuando la
  misma clase de tarea se repite muchas veces.
- **Aislar sin dependencias:** ¿con qué mecanismo del propio sistema operativo, y en qué sistemas? Hasta entonces, sólo artefactos de confianza (§10).
- **El ruido de medida** puede ser grande en máquinas compartidas. ¿Hace falta una máquina dedicada, o contar
  instrucciones en vez de tiempo?
- **Oráculos débiles:** si la corrección se decide con pocos tests, el artefacto puede sobreajustarse a ellos. ¿Generar
  también casos de corrección por familias, como las cargas?
- **Artefactos grandes:** un repositorio real no cabe entero en el contexto. Las observaciones (qué medir) y `view`/`diff`
  por trozos son la respuesta prevista. ¿Basta?
- **Tareas sin métrica de rendimiento** ("que haga X"): el veredicto sería sólo de corrección, y el modelo, de por qué la
  versión cumple. ¿Es otro mundo, o el mismo con métrica vacía?

## 17. Plan

1. **Sandbox mínimo** (procesos locales de Node y Python, sin dependencias) y artefacto versionado.
2. **El objetivo "optimizar"** con oráculo, repeticiones y criterio, y los actos `change`, `run` y `view`.
3. **El primer caso** (§14) con el investigador asistido y su senior. Piloto.
4. **Predicciones prerregistradas de cambios** (pruebas propias) y el vínculo cambio → creencias.
5. **`profile`** y los instrumentos propios sobre perfiles.
6. **Equipos y ramas.**
7. **Una automatización real** con APIs simuladas.

## 18. Implementado

### 18.1 El artefacto versionado y el sandbox mínimo (14/10/2026; plan, paso 1)

- **`lib/src/artifacts/store.ts` (`ArtifactStore`):**
  - la base se lee de un directorio (sin `.git`, `node_modules` ni `__pycache__`), con límites de archivos y bytes;
  - `apply(padre, parche)` crea una versión identificada por el hash de su contenido. El mismo contenido es la misma
    versión: volver a la base es la base;
  - un parche sustituye o quita archivos enteros (`{"files": {"<ruta>": "<contenido>" | null}}`);
  - rutas sólo dentro del artefacto: sin `..`, sin rutas absolutas ni unidades;
  - `materialize`, `diff` (añadidos, quitados, cambiados) y `view` (líneas numeradas).
- **`lib/src/artifacts/sandbox.ts`:** una interfaz (`Sandbox.run(artefacto, ejecución, límites)`) y un backend.
  - **Ejecución:** el comando, la entrada estándar, los archivos de la carga y los archivos de salida que se leen
    después.
  - **Resultado:** código de salida, si se pasó del tiempo, salida estándar y de error recortadas, salidas, tiempo de
    pared y, donde se mide, CPU y memoria máxima. Dice siempre qué backend lo ejecutó y si estaba aislado.
  - **`process` (NO aislado):** un proceso local con el artefacto copiado junto a la carga y un entorno vacío (sólo lo
    que encuentra el runtime: ninguna clave del anfitrión). Mide sólo el tiempo de pared. Es para desarrollo y para las
    pruebas del arnés con artefactos propios.
  - Hubo un backend de Docker (aislado, con medidas del cgroup). Se quitó a petición del autor: el arnés no depende de
    Docker.
- **Pruebas** (`test/artifacts.test.ts`):
  - **Versiones:** por contenido, rechazos, `diff`, `view` y `materialize`.
  - **El backend de procesos:** entrada, salidas, entrada estándar, sin secretos del anfitrión, y el límite de tiempo.

### 18.2 Revisión externa (14/10/2026)

- **Rutas en una sola forma:** `./a.txt` es `a.txt`. Antes eran dos entradas que se escribían en el mismo archivo: `view`
  mostraba una y se ejecutaba la otra, y reconstruir el artefacto daba otro hash.
- **Colisiones rechazadas:** en un parche, en una versión y en una base se rechazan dos nombres que un sistema de
  archivos sin distinción de mayúsculas escribiría como uno.
- **§7 corregido:** el percepto sólo lleva lo que se sabe antes de ejecutar, y las métricas son lo que salió.
