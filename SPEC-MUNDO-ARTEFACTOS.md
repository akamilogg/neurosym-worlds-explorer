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

**La hipótesis de valor** (el autor, 14/10/2026, al conciliar una revisión externa): no es el coste. Es obtener una
**solución interpretable** y una **investigación reconstruible por completo**, porque cada acción en el mundo y cada
edición del artefacto se conservan a propósito. El historial forma parte del resultado y permite reconstruir:
- **qué se produjo:** artefactos, versiones y resultados;
- **cómo se llegó:** experimentos, herramientas, cambios y ramas;
- **por qué se decidió:** hipótesis, predicciones, evidencia y motivos para seguir o volver atrás.

Así otro investigador puede examinar una conclusión, cuestionar un paso concreto y continuar desde ahí, y se distingue una
solución que funciona de una explicación respaldada de por qué funciona. Registrar las razones hace interpretable el
proceso; contrastar sus predicciones respalda la explicación. **El coste decide dónde es viable aplicarlo, no si tiene
éxito.**

- **Corrección antes que rendimiento.** Una variante más rápida y rota no existe: el oráculo de corrección decide
  primero.
- **Sin sobreajuste al benchmark.** Igual que en los mundos de leyes: casos nuevos en cada check, familias de carga
  distintas para validar y cargas que nadie ha visto para confirmar.
- **Medir con ruido.** Los tiempos varían: el veredicto repite ejecuciones y compara con margen, nunca con una sola
  medida.
- **Toda acción con su razón.** Cada cambio del artefacto va con la hipótesis que lo motiva y su predicción, registradas
  antes de medir.
  - **El modelo puede ser local y provisional.** No hace falta predecir con precisión todo el rendimiento. "Este cambio
    mejora las cargas grandes y apenas afecta a las pequeñas" ya orienta experimentos valiosos.
  - **Un cambio puede ser exploratorio,** con su expectativa declarada como incierta. Registrar la incertidumbre es mejor
    que obligar a inventar una explicación convincente antes de cada prueba.
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

### 5.1 Lo que no es: no reimplementar git

El autor teme acabar reimplementando git (14/10/2026). El riesgo es real: un árbol de versiones por hash se parece mucho a
git, y cada necesidad nueva (fusionar ramas, mover archivos, versiones grandes) empuja hacia él. La frontera:

- **Lo que necesitamos y git no tiene:** el vínculo de cada versión con su razón. Qué hipótesis motivó el cambio, qué
  predijo, qué se midió, en qué creencias se apoya y qué se invalida si cae una (§9). Eso es el valor del mundo, y vive en
  el diario, no en el control de versiones.
- **Lo que git tiene y no necesitamos, y no se construye:**
  - **fusiones automáticas:** combinar dos ramas es un cambio más que escribe el investigador, declarando en qué creencias
    de cada rama se apoya (§12);
  - historia reescribible, ramas con nombre, etiquetas, remotos;
  - parches por líneas con contexto: un parche sustituye o quita archivos enteros, o una región que el propio
    investigador indica;
  - detección de renombrados, archivos binarios grandes, permisos.
- **El almacén se queda mínimo:** contenido por hash, padre y parche, y `diff`, `view` y `materialize`. Si algo de lo
  anterior hace falta de verdad, el criterio es **usar git, no imitarlo**. Git ya está en la máquina de quien trabaja con
  código, así que no sería una dependencia nueva como lo sería Docker. Por ejemplo:
  - artefactos que son repositorios grandes: el almacén guarda las versiones como objetos de git
    (`git hash-object`, `git worktree` para materializar), en lugar de copias completas;
  - entregar el artefacto aceptado: se exporta como una rama o un commit del repositorio del usuario, con el mensaje que
    resume su razón y sus predicciones cumplidas.
- **Señal de alarma:** si una tarea pide fusionar texto línea a línea o resolver conflictos, no se resuelve en el
  almacén. Es trabajo del investigador, como cualquier otro cambio, o es el momento de delegar en git.

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

**Dos estados, por separado** (corregido tras una revisión externa: el texto anterior los mezclaba):
- **Artefacto validado:** confirmado a ciegas.
- **Predicciones del modelo respaldadas:** cuáles se registraron antes de medir, cuáles se cumplieron y cuáles fallaron.

El finding da los dos. Un artefacto validado cuyo modelo tiene pocas predicciones cumplidas es un artefacto que funciona y
está **poco explicado**. Un modelo con predicciones cumplidas sobre un artefacto que no se validó es comprensión sin
producto. Ninguno de los dos estados oculta al otro.

## 9. Volver atrás por creencias

El cuaderno ya guarda creencias con su evidencia. Aquí se añade un vínculo:
- **Cada cambio declara en qué creencias se apoya:** `"because": ["<belief id>", ...]`.
- **Cuando una creencia cae** (se descarta o la refuta una prueba), el entorno lista las versiones cuyos cambios se
  apoyaban en ella, y si siguen en la línea de la versión vigente. Es un hecho del registro, no un análisis: decidir qué
  revertir sigue siendo del investigador.
- **El senior lo revisa:** un cambio que sobrevive a la caída de su razón es un cambio sin justificar, no un cambio malo.
- **Una creencia refutada señala cambios que revisar; no demuestra que sean perjudiciales.** El cambio pudo funcionar por
  otra razón: entonces se queda, con su razón corregida, y se anota.

Así, volver atrás no es "ir al commit anterior": es revisar justo lo que dependía de lo que resultó falso, y conservar lo
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

## 11. Repetir, reejecutar, reproducir

Tres garantías distintas (precisadas tras una revisión externa, 14/10/2026):

1. **Reconstrucción histórica:** recuperar exactamente las acciones, ediciones, observaciones y decisiones registradas. La da
   la repetición desde el registro, lo que el arnés ya hace.
2. **Reejecución:** volver a ejecutar el procedimiento con sus dependencias, configuración, semillas y artefactos
   conservados. Para eso hay que guardar también el **entorno de ejecución**: las versiones del runtime y de las
   dependencias que declare la tarea (por ejemplo, la versión de Python, o el `uv.lock` de un gimnasio) y la máquina. Cada
   episodio lleva la huella de ese entorno.
3. **Reproducción del resultado:** comprobar que la conclusión se sostiene al repetir el experimento. Con mediciones
   variables o entrenamientos, con los criterios estadísticos declarados (§8): no los mismos números, sino el mismo
   veredicto.

El registro garantiza la primera. Las otras dos necesitan conservar el entorno y verificar de nuevo los resultados.


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

## 14.1 Más allá del código: formas, diseños y CAD

El autor apunta (14/10/2026) que el mundo sirve igual para **refinar formas o hacer diseños CAD**. La estructura no
cambia: el artefacto es el diseño, y el modelo es el de su comportamiento.

| Pieza | Código | Diseño o CAD |
|---|---|---|
| Artefacto | el programa | el diseño paramétrico: un script CAD (OpenSCAD, CadQuery), una escena de Blender, una malla con sus parámetros |
| Cambio | un parche | cambiar parámetros o geometría: un radio, un espesor, un perfil, una topología |
| Oráculo de corrección | salidas iguales a la referencia | restricciones: dimensiones, holguras, sin interferencias, fabricable (paredes mínimas, voladizos, ensamblaje) |
| Cargas por familias | entradas de datos | casos de uso: cargas mecánicas, condiciones de flujo, temperaturas, tolerancias de fabricación |
| Métrica | tiempo, memoria | masa, rigidez, tensión máxima, arrastre, coste de material, tiempo de impresión |
| `run` / `profile` | ejecutar y perfilar | simular: elementos finitos, CFD, físicas de Blender, cálculo de propiedades de masa |
| Modelo del comportamiento | qué determina el rendimiento | qué determina la métrica: "la tensión se concentra en el chaflán; un radio mayor la baja a la mitad sin añadir más de un 5 % de masa" |

**Lo que aporta aquí el arnés:**
- **Predicciones antes de simular:** cada cambio de forma va con su efecto esperado, y se aprende de los que fallan. Las
  simulaciones son caras, y un modelo que acierta evita muchas.
- **Validación en otras familias de carga y a ciegas:** un diseño optimizado para un caso de carga suele fallar en otro;
  el protocolo obliga a comprobarlo antes de aceptarlo.
- **Volver atrás por creencias:** si cae la hipótesis que justificaba un refuerzo, se ven qué cambios dependían de ella.

**Lo que habría que añadir para este dominio:**
- un simulador por tarea, dentro del sandbox y sin dependencias que el usuario tenga que instalar aparte. Blender ya se usa
  en el mundo 3D; otros simuladores dependerían de la tarea;
- un percepto geométrico: medidas del diseño que sus observaciones puedan leer (dimensiones, volúmenes, secciones), antes de
  simular, como en §7;
- **distinguir ruido de error del simulador.** Repetir una simulación mide su variabilidad, pero no corrige un sesgo
  sistemático por el mallado o por una física insuficiente. Cuando la tarea lo requiera, comprobaciones de convergencia
  (refinar la malla, el paso de tiempo) o de fidelidad (contra un caso con solución conocida). Es la calibración de
  instrumentos (SPEC-CALIBRACION-INSTRUMENTOS) aplicada al simulador.

Sería un segundo caso después del primero de código (§14).

## 14.2 Un gimnasio de RL: enseñar a un robot

El autor propone (14/10/2026) usar el mundo para optimizar un gimnasio de aprendizaje por refuerzo que enseñe a un robot,
partiendo sólo de los parámetros que definen el score.

| Pieza | Gimnasio de RL |
|---|---|
| Artefacto | la configuración de entrenamiento: función de recompensa, currículo, aleatorización del entorno, hiperparámetros, arquitectura de la política |
| Cambio | modificar la recompensa, un hiperparámetro, el currículo o la aleatorización |
| `run` | entrenar una política, con varias semillas, y evaluarla |
| Métrica | el score de la tarea, medido sobre la política ya entrenada |
| Familias de carga | condiciones del entorno: terrenos, masas, fricciones, perturbaciones, objetivos |
| Confirmación a ciegas | condiciones reservadas que el entrenamiento nunca vio |
| Modelo del comportamiento | qué hace aprender o no a la política, por ejemplo: "la penalización por velocidad articular impide que aprenda a saltar; bajarla a la mitad le deja superar el escalón sin aumentar las caídas" |

**La condición clave: recompensa y score separados.**
- **La recompensa es parte del artefacto:** el investigador la cambia, porque es su herramienta para enseñar.
- **El score es el veredicto del entorno:** los parámetros que definen qué es hacerlo bien los declara la tarea, son fijos
  y el investigador no los toca.
- Si la misma cosa se optimizara y se evaluara, aparecería el **reward hacking**: la política aprende a puntuar sin hacer
  la tarea. **Separarlas es necesario, pero no basta.** Un fallo del score también se puede explotar en condiciones
  nuevas: las familias reservadas comprueban la robustez frente a esas condiciones, no que el objetivo esté bien definido.
  - **La defensa principal es que el evaluador mida bien** el objetivo y sus restricciones: el **oráculo de corrección**,
    distinto del score, con el comportamiento que se quiere (no caerse, no pasar de ciertos esfuerzos, terminar en la
    postura pedida);
  - después, la **validación** en otras familias de condiciones y la **confirmación a ciegas**, que miden la robustez.

**Tres productos, no dos** (precisado tras una revisión externa):

| Producto | Qué se comprueba de él |
|---|---|
| **La receta:** recompensa, currículo, hiperparámetros | si produce buenas políticas de forma consistente, con varias semillas |
| **La política entrenada** (su checkpoint) | si ese resultado concreto funciona |
| **El modelo explicativo** del investigador | si sus predicciones sobre los cambios orientan bien la búsqueda |

Una política excelente obtenida con una semilla afortunada no demuestra que la receta sea mejor. El finding identifica los
tres con sus evaluaciones. Una confirmación con entrenamiento completo produce una **política nueva**, que necesita su
propia evaluación.

**Lo que lo hace caro y delicado:**
- **Cada `run` es un entrenamiento completo:** minutos u horas. Es donde más vale el modelo, porque predecir el efecto de
  un cambio antes de entrenar ahorra entrenamientos.
- **El ruido entre semillas es grande:** el veredicto necesita varias semillas por versión y un criterio estadístico
  serio (§8). Una sola ejecución no dice nada.
- **El simulador** (MuJoCo, Isaac, PyBullet o uno propio) es una dependencia de la tarea, no del arnés: lo aporta quien
  la plantea (§10).
- **Si el destino es un robot real,** pasar de la simulación a la realidad es la confirmación a ciegas definitiva, y
  ocurre fuera del sandbox.

**Lo que aporta frente a ajustar a mano o a una búsqueda ciega de hiperparámetros:**
- cada cambio de recompensa queda con su razón y su predicción;
- cuando una idea cae, se ven los cambios que dependían de ella (§9);
- ninguna mejora se da por buena hasta confirmarla en condiciones nuevas.

### 14.3 Un caso concreto: Microduck, el pato de Hugging Face (investigado el 14/10/2026)

El autor propone el robot pato de Hugging Face como juguete para validar §14.2. Lo que hay, según sus repositorios y la
prensa:

**El robot.** Microduck, de Pollen Robotics (comprada por Hugging Face en 2025), es la versión de producto del proyecto
abierto Open Duck Mini (Antoine Pirrone), una miniatura del droide BDX de Disney.
- Es un bípedo de unos 25 cm y menos de 800 g, con 14 o 15 servos (piernas, cuello, cabeza y un pico articulado).
- Su política neuronal corre a 50 Hz.
- Reservas a 399 $ desde agosto de 2026, con entregas previstas antes de Navidad.

**Dos gimnasios abiertos:**

| | `pollen-robotics/microduck_rl` | `apirrone/Open_Duck_Playground` |
|---|---|---|
| Simulador | mjlab (MuJoCo Warp) | MuJoCo, al estilo de MuJoCo Playground |
| Algoritmo | PPO (rsl_rl) | PPO |
| Entrenar | `uv run train Mjlab-Velocity-Flat-MicroDuck --env.scene.num-envs 4096` | `uv run playground/open_duck_mini_v2/runner.py --task flat_terrain_backlash --num_timesteps ...` |
| Coste | GPU CUDA; según el README, entre 1 y 2 horas para un andar usable con 4.096 entornos; o en Hugging Face Jobs (`--hf-jobs`), de pago | GPU; el README no da tiempos |
| Recompensas | `src/mjlab_microduck/tasks/mdp.py`, con reglas de diseño en `AGENTS.md` y pruebas de los signos de las recompensas | `common/rewards.py`, elegidas en `joystick.py`; recompensa opcional de imitación |
| Aleatorización | modelo de actuador (BAM, XL330) con voltaje de batería, caída de tensión, retardo de mando y fricción por entorno, conmutables con `ENABLE_*`; holgura de ±1° en las variantes `-Backlash` | `common/randomize.py` |
| Tareas | andar con mandos de velocidad y de cabeza (`Velocity-{Flat,Rough}`), levantarse, sentarse, recoger con el pico, chutar, patines... | andar con joystick, en terreno plano o irregular |
| Salida | ONNX (61 entradas → 14 objetivos articulares), normalizador incluido | ONNX |
| Licencia | código Apache 2.0; mallas 3D CC BY-NC-SA 4.0 | la página no lo indica |

**Por qué sirve para validar el mundo:**
- **La recompensa ya está separada en un archivo de código** (`mdp.py`): es el artefacto natural, y cambiarla es un parche.
- **Las familias de carga ya existen** como variantes de la tarea y como interruptores de aleatorización: plano frente a
  irregular, con y sin holgura, voltaje, retardo y fricción. Una combinación reservada, por ejemplo terreno irregular con
  holgura y retardo, es la confirmación a ciegas natural.
- **La tarea de andar con mandos de velocidad** da un score que no es la recompensa: el error de seguimiento de la
  velocidad mandada, más las caídas, sobre episodios de evaluación con mandos fijados por la tarea.

**Lo que tendríamos que poner nosotros:**
- **El score y el oráculo,** fuera del alcance del investigador. Un evaluador propio carga la política ONNX y la ejecuta en
  CPU (MuJoCo) sobre episodios fijados por la tarea:
  - el **score** es el error de seguimiento de la velocidad;
  - el **oráculo** pide no caerse, mantener los límites articulares y no sobrepasar un umbral de esfuerzo (con el modelo
    de actuador).

  La recompensa de entrenamiento nunca decide el veredicto.
- **Entrenamientos cortos para iterar, calibrados:** con 1 o 2 horas por entrenamiento, el piloto usaría presupuestos
  reducidos (menos pasos o menos entornos) y compararía versiones con el mismo presupuesto, varias semillas cada una, y la
  validación y la confirmación con presupuesto completo. **Pero un entrenamiento corto es una aproximación que hay que
  calibrar:** una configuración puede aprender rápido y estancarse, y otra empezar peor y terminar mejor. El piloto
  comprueba primero si las comparaciones cortas anticipan razonablemente las completas.
- **Primero, sólo la recompensa:** arquitectura, algoritmo y presupuesto fijos. Después se amplían las variables. Así es
  más fácil interpretar qué aprendió el investigador y cuánto cuesta.
- **Fuera del repositorio:** el gimnasio se clona aparte, como las fuentes de EurekaBench. Su código es Apache 2.0, pero
  sus mallas son CC BY-NC-SA: nada suyo se copia al arnés.

**Lo que hay que resolver antes (preguntas para el autor):**
- **Hardware de entrenamiento:** hace falta una GPU NVIDIA con CUDA, o pagar Hugging Face Jobs. La máquina del autor tiene
  una RTX 3080 Ti con 12 GB. **Pendiente de una prueba local** de compatibilidad, memoria y velocidad: el README da de
  1 a 2 horas con 4.096 entornos, pero no para esta tarjeta.
  Instalar el entorno (uv, dependencias de mjlab) lo hace el usuario: no es una dependencia del arnés (§10, y la regla de
  no imponer dependencias).
- **Coste del piloto:** con presupuesto reducido y unas 3 semillas por versión, cada comparación tarda horas. ¿Cuántas
  versiones caben?
- **Qué tarea:** `Velocity-Flat` para empezar (la más simple, con score claro). Levantarse o chutar después.
- **Sin robot físico,** la confirmación a ciegas es en simulación con condiciones reservadas. Con un robot, el paso a la
  realidad sería la confirmación definitiva.

**Fuentes:**
- [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl)
- [apirrone/Open_Duck_Playground](https://github.com/apirrone/Open_Duck_Playground)
- [Open Duck Mini (DeepWiki)](https://deepwiki.com/apirrone/Open_Duck_Mini)
- [The New Stack: Hugging Face Microduck](https://thenewstack.io/hugging-face-microduck-robot/?p=22834765)
- [AI Weekly: pre-orders for Microduck](https://aiweekly.co/alerts/hugging-face-opens-pre-orders-for-399-microduck-rl-biped)

Algunas cifras de la prensa no coinciden (procesador, sensores, número de servos). Las del entrenamiento salen de los
README de los repositorios.

## 15. Medidas y evaluación

- **Para el operador:**
  - mejora confirmada a ciegas y su intervalo;
  - versiones creadas;
  - ejecuciones gastadas;
  - predicciones registradas, cumplidas y fallidas;
  - cambios revertidos al caer su creencia;
  - tokens.
- **Comparaciones** emparejadas, con la misma tarea, el mismo modelo, el mismo acceso a herramientas y el mismo
  presupuesto total, contando ejecuciones y tiempo además de tokens:
  - frente a un agente de código directo, sin protocolo;
  - frente a una búsqueda ciega, con mutaciones sin modelo;
  - con y sin el requisito de predicciones (`--own-tests`).
- **Qué sostendría la idea** (la hipótesis de valor, §3), en este orden:
  1. **Interpretabilidad:** la solución viene con una explicación cuyas predicciones se contrastaron. Cuántas se
     cumplieron y cuántas fallaron.
  2. **Reconstrucción:** otro investigador puede reconstruir, reejecutar y reproducir el resultado y el camino (§11).
  3. **Fiabilidad:** mejoras que se confirman a ciegas cuando las del agente directo no.

  El coste se mide y se informa, porque decide dónde es viable el método; que cueste menos que un agente directo no es lo
  que se pretende probar.
- **El orden de los pilotos:** primero el ciclo completo con el programa de procesamiento de datos (§14). Después, el mismo
  contrato en Microduck (§14.3), como prueba de que el método es genérico.

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

### 18.3 La tarea, los actos y el veredicto (14/10/2026; plan, paso 2)

**La tarea** (`lib/src/artifacts/task.ts`, `ArtifactTask`) se declara por comandos y salidas, sin suponer qué hace el
artefacto. Así sirve igual para procesar un CSV que para entrenar y evaluar una política (Microduck, §14.3). Declara:
- el artefacto base;
- cómo se ejecuta una versión en una carga: comando, archivos de entrada, archivos que deja y límite de tiempo;
- cómo se leen las métricas y la salida de lo que deja;
- las familias de cargas, cada una un lugar con su papel (laboratorio, familia o ciega), y sus cargas generadas de una
  semilla, con los parámetros que se saben antes de ejecutar;
- el oráculo de corrección, frente a la ejecución de la referencia en la misma carga;
- el objetivo: métrica, dirección, margen, confianza, repeticiones y restricciones.

**El veredicto** (`judge`):
- correcto en todas las ejecuciones;
- mejor que la referencia por el margen: el extremo superior de un intervalo bootstrap, con la confianza pedida, de la
  media geométrica por carga del cociente de medianas, por debajo de 1 − margen;
- ninguna restricción rota.

Es determinista: el bootstrap usa una semilla fija.

**Qué exige cada familia,** que lo declara la tarea antes de ejecutar nada (`requires`):
- **ser mejor por el margen** (lo normal), donde se espera ganar;
- **o sólo no ser peor** (`not_worse`, con una tolerancia), donde no hay nada que ganar y la familia sirve para ver que
  nada se rompe ni se ralentiza.

**Por qué:** exigir mejora en todas las familias haría imposible aceptar nada. En el primer caso, con pocas claves
distintas, todo el tiempo es el arranque de Python, y una versión excelente no puede ser un 10 % más rápida ahí.

**El mundo** (`lib/src/artifacts/world.ts`, `ArtifactWorld`), sobre el almacén y el sandbox:
- `change`: un parche, una versión;
- `run`: una versión sobre cargas de una familia, como episodio. Cada ejecución lleva lo que se sabía antes (la carga y
  la versión) y lo que salió (métricas, y si fue correcta frente a la referencia). Nunca sobre una familia ciega, y dice si
  estaba aislado;
- `check`: el veredicto en unas familias, con cargas nuevas, referencia y candidata intercaladas repetición a repetición y
  alternando quién va primero, para que la deriva de la máquina caiga sobre las dos.

La referencia es la base.

**El primer caso** (`lib/src/artifacts/tasks/dedup.ts`, base en `lib/examples/artifacts/dedup/base/main.py`):
- **El script:** deduplica por clave, filtra etiquetas bien formadas y ordena por valor.
- **Sus ineficiencias son reales y de distinto tipo:**
  - una lista para las claves vistas, cuadrática en las claves distintas;
  - una ordenación tras cada fila conservada, cuadrática en las conservadas;
  - la salida construida por concatenación.
- **Familias:**
  - `mixed`, de 1.200 filas: el laboratorio;
  - `unique`, de 12.000 filas con casi todas las claves distintas: la familia donde está la ganancia (unos 3,6 s la
    base);
  - `duplicates`, de 12.000 filas con pocas claves, que sólo exige no empeorar: casi todo es el arranque, unos 0,17 s;
  - `wide`, de 5.000 filas con etiquetas largas: la ciega.
  
  Los primeros tamaños eran tan pequeños que el arranque de Python dominaba y la ganancia no se distinguía del ruido.
- **Oráculo:** el mismo `out.csv` que la referencia.
- **Métrica:** tiempo de pared, un 10 % mejor con un 90 % de confianza, en tres repeticiones.

**Pruebas** (`test/artifact-world.test.ts`):
- **el veredicto con medidas sintéticas:** mejor, igual, incorrecto, mejor en casi todo pero mucho peor en una carga, y una
  restricción rota; y determinista;
- **el caso real a escala pequeña:**
  - la base es correcta frente a sí misma;
  - una versión eficiente (un conjunto, una sola ordenación, la salida unida de una vez) se sostiene en `unique`;
  - una que olvida el desempate por clave se detecta como incorrecta;
  - un cambio cosmético no se sostiene;
  - la familia ciega no se puede ejecutar.

**Lo que falta** (plan, paso 3): conectarlo al investigador asistido como un laboratorio:
- el percepto de antes de ejecutar;
- la respuesta doble (artefacto y modelo);
- el protocolo de familia y ciegas sobre `check`;
- las predicciones de cada cambio como pruebas propias, incluidas las exploratorias con su incertidumbre declarada;
- la huella del entorno de ejecución en cada episodio (§11, reejecución): versiones del runtime y de las dependencias que
  declare la tarea;
- el finding con los dos estados por separado (§8) y, en RL, los tres productos (§14.2).


### 18.4 El mundo de artefactos como laboratorio (14/10/2026; plan, paso 3)

**El laboratorio** (`lib/src/worlds/artifacts/lab.ts`, registrado como `artifacts`) conecta el mundo al investigador
asistido como un mundo de leyes más. El artefacto se elige con `--artifact` (`dedup`), no con `--task`, que es
el enunciado del operador para el investigador asistido; el piloto, `lib/examples/batch.artifacts-dedup-pilot.json`:
- **Episodios de dos clases:** una versión, que se lee línea a línea, y una tanda de ejecuciones, cada una con su punto.
- **El punto, sólo lo que se sabe antes de ejecutar** (§7): familia, parámetros de la carga, versión, archivos cambiados
  respecto de la base y tamaño de cada archivo. Lo medido nunca está en su propio punto.
- **Los actos:**
  - `change` hace una versión;
  - `run` la ejecuta en cargas nuevas de un laboratorio.
- **El modelo predice la métrica en un punto,** y la comprobación ejecuta la referencia y la última versión en cargas
  nuevas.
- **Las ejecuciones medidas varían,** así que pasan por un canal nuevo, `LabContext.recorded`: se registran en el log de
  replay como respuestas del entorno y, al reanudar, se sirven de ahí. Una reanudación no vuelve a medir, y el diario
  reanudado tiene las mismas medidas.

**La respuesta doble** (§8): el artefacto tiene su propio protocolo, aparte del del modelo.
- **La propuesta** puede llevar `"artifact": "<versión>"` y, cuando se sostiene en todos los laboratorios,
  `"validate_artifact": true`.
- **El protocolo es el mismo de siempre** (`Protocol`), con estas diferencias:
  - sus propios lugares: una familia donde el artefacto no se sostiene pasa a ser laboratorio del artefacto, no del
    modelo;
  - las mismas familias ciegas;
  - la versión como huella;
  - sin regresión emparejada.
- **Lo que decide se sostiene en un lugar es el veredicto de `check`** (§8): referencia y candidata intercaladas, en
  cargas nuevas.
- **A System 2 se le dicen hechos, nunca cuánto** (sin métrica para System 2):
  - si se sostiene;
  - si todo fue correcto, y qué cargas no;
  - si fue mejor (o no peor, donde la familia sólo pide eso);
  - qué restricción se rompió.
  
  El cociente y su intervalo quedan en el diario (`artifact_check`), con lo que se le dijo.
- **Una versión desconocida se rechaza** sin gastar nada.
- **La aceptación se registra en `artifact_accepted`.**
- **El finding tiene el estado del artefacto aparte del del modelo** (`artifact`: aceptado o no, la versión, la ronda,
  cuántas comprobaciones y lo último que se le dijo). Uno puede aceptarse y el otro no.

**Toda acción con su razón** (§3): un `change` lleva su hipótesis y lo que espera (`why` y `expect`), o declara que es
exploratorio (`why` y `exploratory: true`).
- Sin razón, se rechaza.
- La razón queda en el episodio de la versión, escrita antes de medir nada de ella.
- Las predicciones que se pueden comprobar son las pruebas propias de siempre (SPEC-PRUEBAS-PROPIAS), registradas sobre
  los puntos de las ejecuciones. Así, una predicción sobre un cambio se comprueba con los mismos medios que cualquier otra.

**La huella del entorno** (§11, reejecución):
- **Qué recoge.** `ArtifactWorld.environment()` toma una vez:
  - la máquina: plataforma, versión, arquitectura, CPU, núcleos y memoria;
  - Node;
  - el sandbox, y si aísla;
  - lo que digan los comandos de entorno que declara la tarea (`run.environment`; en `dedup`, `python --version`).
- **La huella es el hash de todo eso.**
- **Dónde va.** Cada episodio de ejecuciones y cada veredicto la llevan. El investigador ve la huella en sus episodios, y
  el diario guarda los hechos completos.
- **Al reanudar** se sirve del log, como la medida a la que acompaña.

**Pruebas:**
- `test/artifacts-lab.test.ts`: una corrida asistida con un sustituto de System 2. Lee la base, hace una versión con su
  razón, la ejecuta y propone un modelo. Pone adelante primero una versión inexistente (rechazada) y luego la suya
  (juzgada: sólo hechos a System 2; el cociente y la huella, en el diario). El finding lleva el estado del artefacto. Al
  reanudar salen las mismas medidas y los mismos veredictos del artefacto.
- Su contrato a escala pequeña: un cambio sin razón, o sin expectativa ni `exploratory`, se rechaza.

**Lo que falta:**
- **En RL, los tres productos (§14.2):** receta, política y modelo explicativo. Esperan a una tarea de RL (Microduck,
  §14.3); el laboratorio no supone nada de ellos.
- **Medir en el banco de pruebas.** `test/artifact-world.test.ts` mide tiempos reales. Con la suite en paralelo, la familia
  `duplicates` (unos 0,17 s, casi todo arranque de Python) puede salir peor que la tolerancia por ruido de la máquina.
  Corrida sola, pasa.

### 18.5 El segundo caso: 3SUM (15/10/2026)

**La tarea** (`lib/src/artifacts/tasks/threesum.ts`, `--artifact threesum`): decidir si entre n enteros hay tres, en
posiciones distintas, que sumen cero.
- **Su base** (`lib/examples/artifacts/threesum/base/main.py`) es el programa más simple: tres bucles anidados que paran
  en la primera terna, cúbico en n.
- **Hasta dónde puede bajar** lo encuentra el investigador. La tarea no lo sugiere.
- **Por qué se eligió.** El autor la propuso porque hace poco fue noticia un algoritmo por debajo de O(n²). Aquí se ve
  hasta dónde llega el investigador partiendo de lo cúbico.

**Se decide, no se encuentra.** `out.txt` es `yes` o `no`: es correcta si responde lo mismo que la referencia en la
misma carga. Dos programas pueden encontrar ternas distintas, pero coinciden en si hay una. Algunas cargas llevan una
terna plantada, para que una respuesta fija de antemano no pase.

**Familias** (los tiempos de la base, en la máquina del autor):

| Familia | Papel | Cargas | Base | Exige |
|---|---|---|---|---|
| `mixed` | laboratorio | 300 números en ±10⁹, terna plantada en una de cada dos | ~0,5 s | mejor |
| `large` | familia | 600 números en ±10⁹, sin terna plantada: todo el trabajo cúbico | ~3 s | mejor |
| `dense` | familia | 600 números en ±50: la base encuentra una terna casi al instante | ~0,14 s | no peor |
| `late` | ciega | 600 números en ±10⁹, la terna plantada al final del todo | ~3 s | mejor |

La referencia se ejecuta en cada carga de una comprobación, así que n se queda en cientos.

**Pruebas** (`test/threesum.test.ts`, sólo corrección: los tiempos dependen de la máquina):
- la terna plantada está donde se pide;
- la base es su propia referencia;
- una versión cuadrática (ordenar y dos punteros) responde lo mismo en todas las familias;
- un `no` fijo se detecta;
- la familia ciega no la puede ejecutar el investigador.

**El lote** es `lib/examples/batch.artifacts-threesum.json`.

### 18.6 Un fallo del primer run de 3SUM: la confirmación a ciegas del modelo (15/10/2026)

**El fallo.** En `artifacts-threesum`, el modelo de tiempos se sostuvo en sus tres laboratorios en la ronda 12 y pidió
validarse. La confirmación a ciegas no tuvo ningún punto que juzgar (`judged: 0` en `late`), así que el modelo no podía
aceptarse nunca.
- **La causa:** las comprobaciones del laboratorio pasaban por el mismo `ArtifactWorld.run` que las ejecuciones del
  investigador, y ese `run` rechaza la familia ciega. El rechazo se tragaba sin ruido: ningún episodio.
- **Por qué no se vio antes:** en el piloto de `dedup` el modelo nunca llegó a esa fase.

**El arreglo:**
- `run` sabe quién ejecuta (`by`).
  - **El entorno** (las comprobaciones, también a ciegas) puede ejecutar la familia ciega.
  - **El investigador** (sus actos) sigue sin poder.
- Una comprobación que no puede ejecutarse ya no se traga: es un error visible.
- El registro de repetición no cambia: el cuerpo registrado es el mismo.

**Prueba** (`test/artifacts-lab.test.ts`): una comprobación en un lugar ciego extrae episodios con puntos que juzgar, y
la misma familia sigue cerrada para el investigador.

### 18.7 La investigación sigue tras aceptar el modelo (15/10/2026)

**De dónde sale.** En `artifacts-threesum-senior`, el modelo de tiempos se aceptó en la ronda 5 de 12 y el run terminó
ahí, como termina cualquier run al aceptar su modelo. El aviso del operador (ronda 6) llegó en la reflexión final, sin
ronda para intentarlo. En un mundo cuyo producto es el artefacto, "lo más rápido que puedas dentro de tu presupuesto"
choca con esa regla: entender bien los tiempos de una versión no es el final de la investigación.

**El cambio:**
- **Un mundo puede declararlo** (`Lab.goesOnAfterAcceptance`); el de artefactos lo hace.
- **Al aceptarse un modelo:**
  - la aceptación se registra (`accepted`);
  - empieza una etapa nueva, como en una continuación tras una aceptación (`stage_after_acceptance`, con
    `goes_on: true`): lo comprobado antes no cuenta y se devuelven las validaciones;
  - el arnés se lo dice por su canal, con un aviso: el modelo aceptado y que la investigación sigue hasta agotar el
    presupuesto;
  - el run sigue hasta su última ronda.
- **El protocolo del artefacto no se reinicia:** sus versiones aceptadas siguen siéndolo.
- **El modelo del run es el último aceptado,** y el finding da su ronda; antes tomaba la primera aceptación.
- **Capacidad `goes_on`:** sólo los runs que empiezan con ella. Un mundo que no lo declara se detiene al aceptar, como
  siempre.

**Pruebas** (`test/goes-on.test.ts`):
- **Un mundo que lo declara:** acepta, abre etapa nueva, se lo dice por el canal en la ronda siguiente y llega a su
  última ronda. El finding da la última aceptación.
- **Sin la declaración,** el run se detiene en su aceptación.

**El lote** `lib/examples/batch.artifacts-threesum-subquadratic.json`:
- un par junior/senior (8 órdenes del senior, presupuesto de ayuda 8);
- leen la investigación anterior como experiencia (`--experience`, modo `meta`);
- desde el principio se les pide descubrir la solución comprobada ligeramente por debajo de O(n²).

### 18.8 Revisión externa (16/10/2026): las garantías de reconstrucción

Una revisión del estado hasta `9a4d50e` encontró cuatro fallos de las garantías del arnés (§11) y los reprodujo. Los
cuatro rompen lo mismo: que la investigación entera se pueda reconstruir y revisar, sin imponer cómo investigar.

**1. Una comprobación del artefacto guardaba su conclusión, no su evidencia.**
- **El fallo:** `measureCheck` devolvía sólo el veredicto agregado, y se perdían los tiempos, las salidas y el orden de
  cada ejecución. No se podía recalcular el veredicto ni investigar una anomalía de medición.
- **El arreglo:** cada comprobación guarda su evidencia (`CheckEvidence`). Por carga, cada ejecución de la referencia y de
  la candidata registra:
  - su repetición y quién fue primero;
  - código de salida, tiempo agotado y métricas;
  - la salida entera si es corta, o su resumen (`sha256`, caracteres) si no;
  - el principio de su `stderr`.
- **Dónde queda:** en el registro de repetición y en el diario (`artifact_check`, del operador). El investigador no la ve,
  como el resto de las medidas de una comprobación.

**2. La reconstrucción dependía de que la base siguiera intacta.**
- **El fallo:** el mundo cargaba la base de su directorio y el diario sólo guardaba su hash. Con la base cambiada, un run
  reanudado divergía.
- **El arreglo** es general. Un laboratorio declara qué de su mundo hay que guardar para reconstruir un run
  (`Lab.archive`) y cómo reponerlo (`Lab.restore`).
  - El runner lo archiva en el diario al empezar (`world_archive`) y, al reanudar, lo devuelve antes de nada.
  - El de artefactos archiva su base entera. `ArtifactWorld.restoreBase` comprueba que el archivo da el hash de la base
    que nombra, y que todavía no se ha hecho ninguna versión.

**3. Una familia que abrió la validación del artefacto seguía cerrada para experimentar.**
- **El fallo:** los protocolos del modelo y del artefacto tienen lugares separados, y `act` sólo miraba los del modelo.
  El investigador recibía `now_your_laboratories: ["unique"]` y, al actuar allí, "you can act only in your laboratories:
  mixed". No podía estudiar justo el contraejemplo encontrado.
- **El arreglo:** los veredictos siguen separados, y el permiso de experimentar se comparte. Puede actuar en los
  laboratorios de cualquiera de los dos protocolos. Capacidad `shared_laboratories`.

**4. El mismo contenido alcanzado desde otra rama daba una procedencia equivocada.**
- **El fallo:** el almacén devolvía la versión ya conocida, con el padre de la primera vez. Al transformar B en el
  contenido de A, el episodio declaraba como padre la base, aunque el cambio salió de B.
- **El arreglo:** el contenido se guarda una vez, por su hash, y cada transición aparte (`ArtifactStore.transitions`:
  origen, destino y parche), todas las veces. `change` devuelve como padre el origen de ese cambio, y el episodio de
  versión lo muestra. Deduplicar contenido no deduplica la historia de cómo se llegó a él.

**Pruebas** (`test/artifacts-review.test.ts`), cada una como la revisión reprodujo su fallo:
- dos ramas que llegan al mismo contenido;
- la evidencia completa de una comprobación;
- un run cortado, su base cambiada y el run reanudado sin divergir;
- una familia abierta por la validación del artefacto, donde el investigador actúa.

**Lo que la revisión deja pendiente, sin implementar todavía:**
- **La interpretabilidad estructurada.** Hoy se registran `why` y `expect`. Falta:
  - el vínculo `because → creencias` de cada cambio;
  - identificar los cambios afectados cuando se refuta una creencia;
  - asociar explícitamente el artefacto entregado con las predicciones que lo explican.

  Aceptar el modelo acredita su predicción de tiempos bajo el protocolo; por sí solo no acredita una explicación de las
  mejoras.
- **Diferencias con esta spec:**
  - `profile` (§6);
  - la comprobación de construcción al editar;
  - la restricción de memoria del piloto;
  - la regresión emparejada del artefacto, desactivada en la implementación: cada comprobación usa cargas nuevas, y
    volver a ejecutar las de la comprobación anterior aún no está.

### 18.9 Segunda revisión (16/10/2026): las garantías, enteras

La revisión de `35ad463` encontró que dos arreglos resolvían el caso reproducido y no la garantía entera, y una
limitación de conservación. Los tres se arreglan desde su principio:

**1. Un run reanudado no lee nada de disco que no guardara él mismo.**
- **El fallo:** se generaba el mundo desde el directorio y luego se reponía la base archivada. Con el directorio
  borrado o movido fallaba (`ENOENT`) antes de usar el archivo.
- **El arreglo:** `Lab.generate` recibe lo archivado (`archived`) y el mundo se construye directamente desde ahí
  (`ArtifactWorld.storeFromArchive`, que comprueba el hash). El directorio no se vuelve a leer. Desaparece `Lab.restore`.

**2. Dónde puede experimentar es un único conjunto, para cualquier camino.**
- **El fallo:** `act` ya consultaba los laboratorios de los dos protocolos, pero `register_test` seguía mirando sólo los
  del modelo.
- **El arreglo:** el runner tiene un solo conjunto de lugares habilitados (`actable`), que consultan tanto los actos como
  las pruebas propias.

**3. Reconstruir íntegramente es conservar el contenido, no sólo su resumen.**
- **El fallo:** las salidas de más de 2.000 caracteres quedaban sólo como hash, y `stderr` se recortaba a 500. Se podía
  comprobar la identidad, pero no volver a leer el contenido.
- **El arreglo:** lo que no cabe en línea se guarda entero, por su contenido (`LabContext.keep`), en `blobs/<sha256>`
  junto al diario. La carpeta la comparten los runs de esa carpeta: el mismo contenido es el mismo archivo. La evidencia
  nombra su hash y su tamaño, y dice que está guardado (`kept`).

**Pruebas** (`test/artifacts-review.test.ts`):
- un run reanudado con la base cambiada, y otra vez con su directorio borrado, sin divergir;
- en un lugar que abrió la validación del artefacto, un acto aceptado y una prueba propia que no se rechaza por el lugar;
- un `stderr` largo guardado entero y leído de nuevo.

### 18.10 Tercera revisión (16/10/2026): los huecos de la reconstrucción

Una auditoría externa del arnés señaló dos huecos concretos en la promesa central, la reconstrucción íntegra (§11.1).
Las demás conclusiones, ya definidas en otras specs, se recogen aparte (RIESGO-MODELOS M1, §9 de esta spec,
CONTROL-ARNES K1–K3).

**1. Lo que se guardaba "entero" ya venía recortado.**
- **El fallo:** el sandbox recortaba stdout y stderr a 20.000 caracteres antes de que la evidencia los guardara.
- **El arreglo:** el sandbox captura cada flujo entero hasta un tope duro (`CAPTURE_MAX`, 16 M caracteres) y cuenta lo que
  pase de ahí (`whole`, con `dropped`). Lo que se muestra sigue recortado; lo que se guarda como evidencia es la captura.
  Si la propia captura perdió algo, la evidencia lo dice (`stderr_whole.dropped`): nada se llama entero si no lo es.

**2. Al reanudar en otra carpeta, los blobs se quedaban atrás.**
- **El fallo:** las referencias viajaban con el diario y los contenidos se quedaban en la carpeta del run original.
- **El arreglo:** un run reanudado se lleva los blobs de su historia a su propia carpeta (`carryBlobs`).
  - Cada archivo se comprueba contra el hash que lo nombra: uno corrupto no se copia.
  - Lo que el diario cita y no está se informa.
  - El diario nuevo lo registra (`blobs_carried`: copiados, que faltan, corruptos).

**Pruebas** (`test/artifacts-review.test.ts`):
- un `stderr` de 30.000 caracteres, guardado entero;
- `carryBlobs` con un blob bueno, uno manipulado y uno citado que falta;
- un run reanudado en otra carpeta que se lleva sus blobs y lo registra.

### 18.11 Volver atrás por creencias y la cadena del producto (16/10/2026; §9, plan paso 4)

Implementa §9 y el vínculo que pedía la auditoría externa: una cadena consultable entre afirmación, evidencia y solución.
No impone estrategia: conserva las relaciones, las muestra y deja decidir al investigador.

**`because`.** Un `change` puede declarar en qué creencias de su cuaderno se apoya (`"because": ["<belief id>", ...]`).
Queda con la razón del cambio, en su transición (`ArtifactTransition.reason`).

**Cuando cae una creencia** (el investigador la descarta):
- **el entorno lista los cambios que se apoyaban en ella** (`Lab.dependents`): para cada uno, su versión, su origen, su
  razón y si sigue en la línea de la última versión hecha (`ArtifactStore.ancestry`);
- **llega como aviso del mundo** en el canal, en la ronda siguiente, y queda en el diario (`beliefs_fell`). El senior lo
  recibe por el espejo;
- **es un hecho del registro, no un análisis.** Qué revertir, o si el cambio se queda con su razón corregida, lo decide el
  investigador.

**La cadena del producto.** El fin del run y el finding (`artifact.lineage`) enlazan el artefacto entregado (la última
versión aceptada) con el camino que lo hizo desde la base (`Lab.lineage`, `ArtifactStore.lineage`). Cada cambio aparece
con:
- su razón (`why`, `expect` o `exploratory`, `because`);
- las creencias en que se apoyaba, con su estado al final del run: mantenida, confirmada, descartada o nunca escrita;
- las pruebas propias registradas sobre esa versión, con su resultado o "not run".

Así, una mejora aceptada cuya razón se descartó se ve tal cual: un cambio que funciona por otra razón, o sin una
comprobada.

**La interfaz del mundo de artefactos lo dice:** qué es `because` y que, si cae una creencia, se le dice qué cambios se
apoyaban en ella.

**Pruebas** (`test/artifacts-because.test.ts`):
- `because` se valida; cuando cae una creencia, los cambios afectados, dentro y fuera de la línea de la última versión;
  y el linaje desde la base;
- un run de 3SUM en el que el investigador simulado hace la versión cuadrática apoyada en una creencia, la valida, registra
  una prueba propia sobre ella y descarta la creencia. El aviso llega en la ronda siguiente, y el finding da el producto
  con su cadena: razón, la creencia descartada y la prueba con su resultado.

**Pendiente:**
- **Una predicción sobre un cambio como prueba propia ligada a él al hacerlo** (registrarla junto al `change`). Hoy se
  liga por la versión que nombra la prueba.
- **Que el senior revise expresamente** los cambios que sobreviven a la caída de su razón: recibe el aviso, pero su papel
  no lo nombra.
