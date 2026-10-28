# Catálogo de metapolíticas de investigación

Estado (28/10/2026): **diseño y semillas documentales; no son políticas aprendidas ni ejecutables validadas**.
Complementa [SPEC-METAPOLITICA-INVESTIGACION](SPEC-METAPOLITICA-INVESTIGACION.md). M1, incorporado en `cd419d0`,
permite empezar por una política individual; este catálogo define cómo reutilizarlas y aprender a elegirlas.

## 1. Qué se conserva

Una skill de investigación es un procedimiento reutilizable: qué observar, cuándo puede servir, qué trabajo sugiere,
qué resultado buscar y cuándo dejar de aplicarlo. Su ejecución puede combinar código, juicios semánticos e instrucciones
para el investigador. El LLM concreta las hipótesis y experimentos con sus herramientas habituales.

Cada entrada materializada conserva:

- ID legible, versión por contenido y contrato de entrada; las referencias fijan versiones, nunca `latest`.
- Ficha legible por el investigador, procedimiento ejecutable `research-policy@1` y capacidades necesarias.
- Aplicabilidad propuesta, límites conocidos y condiciones de retirada o abstención.
- Padres y cambios, experiencia utilizada y referencias a ensayos donde ayudó, falló o quedó inconclusa.

La ficha y cualquier otro texto que reciban el LLM o el selector forman parte de la identidad de uso. La evidencia
detallada se conserva para el operador; al investigador sólo llega su proyección autorizada. Una ficha no filtra las
respuestas de confirmación. Exportarla como `SKILL.md` permite reutilizar sus instrucciones, pero un lector de Markdown
no ejecuta por sí solo las reglas, el estado o el registro del arnés: esa modalidad se identifica por separado.

El catálogo se puede usar con un solo modelo. No exige un senior ni que todas sus políticas empleen Jev.

## 2. Semillas iniciales

Estas fichas son hipótesis de método para desarrollar y contrastar. Sus nombres no constituyen una taxonomía obligatoria
ni su orden un ciclo. La búsqueda puede modificarlas, combinarlas, eliminar entradas o crear métodos que no figuran aquí.

| ID | Situación que invita a considerarla | Procedimiento propuesto | Resultado observable que interesa |
|---|---|---|---|
| `develop-prediction` | Una explicación sigue produciendo predicciones nuevas y contrastables. | Elegir una consecuencia todavía no observada, explicitarla y probarla; ajustar lo necesario sin cambiar a la vez todos los supuestos. | Predicción contrastada y delimitación de dónde sigue funcionando la explicación. |
| `discriminate-alternatives` | Varias explicaciones compatibles con lo observado conducen a decisiones distintas. | Identificar una intervención con respuestas diferentes bajo las alternativas; registrar esas respuestas esperadas y contrastarlas. | Una alternativa descartada, una diferencia medida o evidencia de que la prueba no discriminó. |
| `check-instrument` | Una contradicción puede proceder del instrumento, del procedimiento de medida o del mundo. | Replicar bajo condiciones comparables, usar controles o una medida independiente y separar las posibles causas. | Evidencia sobre la fiabilidad de la observación; también puede sostener que la anomalía pertenece al mundo. |
| `localize-regression` | Una revisión conserva una mejora y pierde capacidades antes observadas. | Recuperar versiones y casos, localizar el cambio responsable y probar una reparación o volver a una versión anterior. | Qué capacidad se perdió, por qué cambio y qué revisión conserva ambas; sin suponer que volver atrás resuelve todo. |
| `reframe-representation` | Los cambios recientes recorren el mismo mecanismo sin aclarar la dificultad. | Identificar un supuesto limitante; construir una representación o analogía estructural alternativa y derivar una predicción que distinga ambas. | Una dirección comprobable, incluida evidencia que descarte la nueva representación. |
| `simplify-procedure` | La complejidad dificulta medir, interpretar o dedicar recursos al mecanismo relevante. | Retirar una pieza o sustituirla por una aproximación explícita, conservando un contraste de lo que debe seguir funcionando. | Menos complejidad con capacidad conservada, o identificación de la función de la pieza retirada. |
| `explore-independent` | Una alternativa requiere trabajo propio o los intentos comparten un supuesto no contrastado. | Encargar una investigación delimitada o una búsqueda evolutiva, si están habilitadas; proporcionar evidencia y un encargo que permita discrepar. | Una explicación, artefacto o descarte que el solicitante pueda inspeccionar y probar. |

Cada orientación necesita referencias a observaciones concretas del recorrido. La mera falta de mejora en una puntuación
no activa automáticamente `reframe-representation`: puede haber progreso al descartar explicaciones. Una inconsistencia
no prueba un fallo del instrumento. Una variante distinta no acredita una dirección útil.

Las salidas siguen `develop`, `contrast`, `reframe` o `abstain`. Por ejemplo, localizar una regresión puede comenzar con
`contrast` y más adelante recomendar `develop`. La skill no obliga a ejecutar herramientas, cerrar rondas ni delegar.

## 3. Selección dinámica

El artefacto `research-catalog@1` fija las entradas por hash y, cuando se usa selección automática, incluye el selector.
El selector utiliza el mismo contrato de observaciones autorizadas, código y juicios opcionales de las políticas.
Decide mantener la entrada actual, activar otra o no aplicar ninguna. No evalúa todas las políticas por defecto:
selecciona sobre sus fichas y la captura; después se evalúa sólo la seleccionada.

Se distinguen dos condiciones de uso:

- **Elección del investigador:** consulta el índice y las fichas y selecciona o libera una entrada mediante una petición
  tipada. Esta capacidad se añade al protocolo asistido; no se infiere que una mención casual del cuaderno sea una orden.
- **Elección automática:** el selector versionado decide desde la captura antes de la siguiente pregunta al junior.
  Sus criterios son investigables; la abstención es válida. El junior sigue pudiendo cuestionar sus consejos.

El manifiesto fija cuál de las dos condiciones se utiliza. No se mezclan silenciosamente ni se presenta la capacidad del
LLM de elegir como capacidad de un selector aprendido. Consultar una ficha es lectura registrada; un consejo automático
consume ayuda una sola vez según el contrato de la spec. Toda inferencia y todo contexto añadido cuentan en sus costes.

Como máximo hay una política activa y una orientación automática por corte. El selector tiene estado propio y cada
activación de una política comienza con su estado inicial; mantenerla conserva ese estado. Cambiar A → B → A no recupera
un estado privado antiguo de A. La captura sí incluye la historia autorizada de esas intervenciones.

El registro conserva catálogo, entradas elegibles, elección, motivo, corte, estados y consejo entregado. Un fallo o una
salida obsoleta no activa otra política por detrás. Reanudar reconstruye la misma activación sin repetir consultas ni
entregas. Un selector aprendido puede evitar cambios improductivos; el arnés no impone una alternancia metodológica.

El catálogo, las fichas y el selector permanecen congelados durante el ensayo. Elegir otra entrada del mismo catálogo
es comportamiento previsto; editar sus contenidos durante el ensayo cambia el procedimiento evaluado.

## 4. Evolución de métodos y repertorios

Se distinguen **la población de candidatos en búsqueda** y **el catálogo disponible en un run**. El motor evolutivo ya
gestiona desarrollo, reparación, élites y linajes. El catálogo referencia artefactos de ese registro; no crea otra
autoridad de población ni un sistema de presupuestos independiente.

La búsqueda puede transformar tres objetos:

1. **Una política:** observaciones, reglas, composición, memoria e instrucciones.
2. **El selector:** cómo reconoce situaciones y elige entre políticas, incluida la decisión de abstenerse.
3. **El conjunto:** incorporar especialistas, retirar redundancias o recombinar procedimientos compatibles.

El candidato evaluado para selección dinámica es el conjunto materializado de catálogo, políticas y selector.
Se empaqueta con todas sus dependencias. El evaluador de ensayos mide el comportamiento del conjunto con el junior;
no suma las puntuaciones aisladas de sus miembros ni considera que más entradas impliquen más capacidad.

Una política especializada puede ser útil dentro de un repertorio aunque pierda como política única. La utilidad
individual puede estudiarse retirándola o intercambiándola en nuevos ensayos. Que estuviera activa antes de un éxito
no basta para atribuírselo. No se expulsa una candidata del desarrollo sólo porque todavía no gane: se reutilizan las
oportunidades acotadas del motor existente.

El objetivo y los casos exteriores permanecen fijos. Una candidata no puede mejorar su evaluación borrando del ámbito
de prueba los casos donde falla. Los ensayos locales de un especialista declaran antes su ámbito; la evaluación del
repertorio conserva el encargo completo. Las etiquetas de las fichas no son medidas de diversidad de comportamiento.

## 5. Investigar el propio método

El bucle de mejora se puede cerrar por generaciones:

1. El investigador utiliza el repertorio congelado C(n) para investigar políticas y selectores candidatos.
2. Contrasta los descendientes en ensayos interiores y conserva su evidencia con el evaluador exterior fijo.
3. Publica una versión C(n+1) según el criterio de promoción configurado; si ninguna cumple, conserva C(n).
4. Una nueva investigación puede utilizar C(n+1) para desarrollar la generación siguiente.

Eso define una forma acotada de automejora recursiva del procedimiento. Para observarla hace falta que la mejora del
método se use realmente en la siguiente investigación del método. Obtener una política mejor para un junior desde un
investigador exterior que nunca cambia demuestra aprendizaje de una política, pero no demuestra todavía ese ciclo.

La recursión no requiere procesos ilimitados ni nuevos privilegios. Se reutilizan ensayos, delegación, reservas y
registro. Cada generación declara su referencia y su presupuesto, y no modifica el evaluador. Los casos de confirmación
usados para seguir desarrollando pasan a ser experiencia; la siguiente confirmación necesita casos reservados nuevos.

Buscar estructuras y ajustar parámetros son transformaciones compatibles. Si se usa optimización por gradientes,
se registra qué parámetros cambió y cómo vuelven al programa legible. No se presupone que los runs completos, las
llamadas al LLM o sus decisiones discretas sean diferenciables. Ninguna dependencia de Handwired es necesaria aquí.

## 6. Integración y aceptación

La política individual de M1 y el evaluador de M2 siguen siendo las primeras piezas. Sobre ellas se añaden:

- **Catálogo y selección:** fichas y contenido verificables, elección explícita o automática, una activación por corte,
  cambios y abstenciones, aislamiento de estados, costes y replay. Se prueba que cambiar de política no cambia permisos,
  evaluador ni presupuesto y que una referencia inexistente o incompatible no se sustituye silenciosamente.
- **Evolución del repertorio:** materializar, mutar, recombinar, evaluar y empaquetar el conjunto con el motor existente.
  Pruebas con ensayos simulados verifican especialistas complementarios, una recombinación que empeora, dependencias
  ausentes y continuidad de linajes. La mejora real requiere ensayos con investigadores.
- **Bucle entre generaciones:** C(n) permanece congelado mientras produce candidatos para C(n+1); la siguiente generación
  puede usar la nueva versión y su registro identifica cuál utilizó. No hay promoción por autocalificación del candidato.

Para valorar la selección dinámica se compara el repertorio con una política fija seleccionada en desarrollo y con
una rotación fija de procedimientos. Se mantienen junior, capacidades y límites comparables; se conservan resultados
por trabajo consumido y por tiempo transcurrido. Así se distingue mejor método de más oportunidades de ensayo.

Como referencia sencilla, [local-autoresearch rota cuatro encargos](https://github.com/conglu1997/local-autoresearch/blob/8ded3cc30bcf443f96e3c73939a106a906bf1871/runner/teams.py):
refinar, cambiar representación, simplificar y cuestionar un supuesto. Ese selector fijo puede servir de control;
no acredita que aprender a seleccionar vaya a superarlo.
