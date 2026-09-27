# SPEC · El modelo del mundo: descubrir las reglas y validarlas como un investigador

**Fichero:** `SPEC-MODELO-DEL-MUNDO.md`
**Estado (27/09/2026):** la parte del mundo físico está implementada (`SPEC-MUNDO-FISICO.md` §8.4–8.5, commit
`9656ef2`). De la cuadrícula están hechas G1 (la familia de tableros), la calibración de §7 y G4 (el protocolo del
investigador para la estrategia, §8.2). **G2 y G3 (el artefacto de reglas y su prueba) quedan descartados de momento**
(§8.1); G5 sigue pendiente.

---

## 1. La idea común

En los dos mundos del experimento, lo que System 2 descubre es un **modelo del mundo**: unas reglas que predicen qué
pasa a continuación a partir de lo que percibe. Y en los dos se valida igual, como lo haría un investigador sin la ley
verdadera a mano:

1. **Predicciones arriesgadas** sobre lo que el mundo hará.
2. **En montajes que no ha visto**, de una familia regida por el mismo principio (invariancia).
3. **El mundo responde** y la comparación es sobre hechos observables. Nunca se compara con la verdad oculta, que queda
   como medida del operador en el journal.
4. **Veredicto por predicción**, como un investigador que evalúa sus resultados parcial o totalmente. Sin métricas
   agregadas, sin decirle dónde ni por qué falla, sin elegir por él.

| | Mundo físico (`orbit@1`) | Cuadrícula (`grid@1`) |
|---|---|---|
| **Las reglas son** | la ley: cuánto se aparta la siguiente posición de repetir el último paso | qué cambios permite el mundo desde una posición, y si termina la partida y cómo |
| **Expresadas en** | código sobre la tabla (y reglas de Jev, si quiere) | código sobre la imagen (y reglas de Jev, si quiere) |
| **El mundo responde** | con la posición siguiente | con qué movimientos existen de verdad y con el final real |
| **Familia de montajes** | 1 a 3 cuerpos en otros sitios, ejes girados y desplazados | otros tableros con las mismas reglas: otro tamaño, otra salida y otro número de piezas |
| **Qué se mantiene** | la ley, la escala, la unidad de tiempo, la reflexión (y el giro, si la ley es anisótropa) | los vectores de movimiento, las condiciones de victoria, la forma del tablero, el límite de jugadas y la orientación de la imagen |
| **Veredicto por predicción** | desviación por eje en [−1, 1] | acierto o fallo de cada movimiento y de cada final |
| **Aceptación** | compatible con el ruido observado más la precisión declarada, en cada montaje | **exacta**: el mundo es determinista, así que todo tiene que coincidir en cada montaje |

### 1.1 El protocolo, igual en los dos mundos (acordado el 26/09/2026)

1. **Un montaje.** System 2 empieza en un solo montaje (el laboratorio: en la cuadrícula, el tablero base). Cada ronda,
   su modelo se comprueba allí en casos que no ha visto.
2. **Él decide cuándo validar.** Si su modelo se sostiene en todos sus laboratorios, se valida en una familia finita de
   montajes que no ha visto, más una regresión en sus laboratorios. Hay un presupuesto de validaciones; pedir una antes
   de tiempo se rechaza sin gastarla.
3. **El montaje donde falla pasa a ser laboratorio**, para estudiarlo.
4. **Cuando se sostiene en toda la familia,** la confirmación ciega en montajes nunca vistos decide la aceptación.

Implementado en el mundo físico (`SPEC-MUNDO-FISICO.md` §8.6). En la cuadrícula, las fases G3 y G4 lo siguen. El prompt
explica el protocolo sin anunciar la familia ni qué varía en ella (§6).

## 2. La cuadrícula: el artefacto de reglas

Además de la fórmula (su estrategia), System 2 propone **reglas**: dos funciones de código sobre lo percibido (el
mismo objeto `p` que leen sus observaciones: la imagen, las celdas, sus símbolos, quién mueve y la jugada).

```json
"rules_of_the_world": {
  "moves":  { "definition": "...", "source": "(p) => [[fromRow, fromCol, toRow, toCol], ...]" },
  "ending": { "definition": "...", "source": "(p) => null | -1 | 0 | 1" }
}
```

- **`moves(p)`:** los cambios que cree permitidos para el bando que mueve, en coordenadas de la imagen.
- **`ending(p)`:** `null` si la partida sigue; si no, cómo termina para su bando, con la misma escala de −1 a 1 con que
  ya conoce los resultados (lo interpretó él solo en los runs 14 y siguientes).

Son opcionales hasta que las proponga, pero la aceptación final las exige. Se escriben en código porque se leen como
reglas: "una pieza de `@` avanza una fila y cambia de columna como mucho una".

## 3. La familia de tableros

El mismo juego de la semilla (los mismos vectores de movimiento para cada bando, las mismas condiciones de victoria, la
misma forma de tablero), en montajes distintos:
- **Tamaño:** otro ancho y otro alto, de 5 a 8.
- **Salida:** otra disposición de las piezas en sus bandas.
- **Número de piezas:** entre 2 y 4 para el bando de System 2 y entre 1 y 2 para el otro.

Hay tres cosas que se mantienen porque son el principio, no el montaje:
- **La orientación de la imagen:** "hacia delante" es una dirección del mundo, como el eje de una ley anisótropa.
- **El límite de jugadas:** si dependiera del tamaño, la regla del final mezclaría dos cosas.
- **La forma del tablero** (completo o damero).

**Qué obliga:** reglas relativas al tablero que se ve. "Gana al llegar al **borde opuesto**", no "a la columna 4". En el
run 9 la meta se estrechó hacia la casilla (0,4); en el run 18 la fórmula usaba casillas absolutas, (1,3) y (1,4).
Esas reglas y fórmulas fallarían en un tablero de otro tamaño.

Cada tablero tiene que ser jugable y no trivial: el filtro de `generateSpec` (ambos bandos pueden mover y ganar, y no se
decide en dos jugadas) se aplica a cada montaje.

## 4. La prueba de las reglas y su veredicto

**Las posiciones:** en cada ronda, 3 tableros nuevos de la familia. En cada uno, las posiciones de unas partidas
jugadas por el entorno: el bando de System 2 con su fórmula y el otro con su planificador. Se incluyen posiciones de los
dos bandos y las finales.

**El veredicto, por posición.** Son hechos que el mundo da al contrastar la predicción, lo mismo que haría `act`
sistemáticamente:
- los movimientos que predijo y el mundo **no permite** (cuáles son: son afirmaciones suyas);
- **cuántos** movimientos permite el mundo que no predijo. El número, no la lista, para no darle los movimientos hechos;
- si el final predicho coincide con el real, y cuál fue el real, porque el final de una partida siempre se ve.

**Después de la prueba,** esos tableros y partidas pasan a ser suyos para estudiarlos, con `view`, `act` y `replay`.

**La aceptación de las reglas:** **cero fallos** (ningún movimiento de más ni de menos, ningún final equivocado) en los
tableros de la prueba y en dos conjuntos más de tableros de confirmación ciega. Como el mundo es determinista, no hace
falta tolerancia. Un único fallo es un contraejemplo.

## 5. La estrategia: la fórmula

La fórmula se sigue validando con **partidas ganadas**, que son hechos del juego, ahora también en tableros de la
familia. Además:
- **Regresión emparejada** (la propuesta del usuario). Sus partidas perdidas y ganadas se rejuegan desde las mismas
  salidas, con las mismas semillas del rival, con la fórmula anterior y con la nueva. Se cuentan las que pasan de
  perdidas a ganadas y las que pasan de ganadas a perdidas. Una fórmula que gana las perdidas pero pierde otras que
  ganaba no ha entendido; ha movido el problema.
- **Aceptación de la fórmula:** ganar todas las partidas en los tableros nuevos, de la prueba y de la confirmación, y
  ninguna regresión en el emparejado.

**Fase posterior (sin especificar aún):** que la búsqueda juegue con **sus** reglas en lugar de las reales, como en el
mundo físico su ley es su modelo. Entonces unas reglas equivocadas harían perder de verdad.

## 6. Lo que ve System 2

- **El prompt no dice nada del mundo** (cero pistas, `SPEC-MUNDO-FISICO.md` I5): ni que es un juego de dos jugadores,
  ni que hay una familia de tableros, ni qué cambia entre ellos. Explica el artefacto de reglas solo con la interfaz: los
  cambios en el formato de `act` y el final en la escala con que ya recibe los resultados. Que los tableros de la prueba
  tienen otro tamaño lo descubre al verlos.
- **Recibe** el veredicto por posición, si se aceptaron las reglas y la fórmula, el resultado de sus partidas y los
  tableros de las pruebas como datos.
- **No recibe:** tasas de acierto agregadas, ni qué regla falla ni por qué, ni los movimientos que no predijo, ni una
  "mejor versión".

## 7. Calibración antes de cualquier run

1. **Las reglas verdaderas, escritas en código sobre la imagen**, aprueban en todos los tableros de la familia (en 60
   montajes al menos). Si no, el fallo es del entorno o de la percepción, no del aprendiz.
2. **Unas reglas "de un solo tablero"** (la meta en una columna fija, un límite de filas fijo) fallan en tableros de
   otro tamaño.
3. **Unas reglas con un movimiento de menos** (por ejemplo, olvidar un paso hacia atrás del rival, como en el run 7)
   fallan.

### 7.1 Resultado de la calibración (G1)

- **`worlds/grid/family.ts`:** `boardOf(base, index)` genera tableros con el tamaño (5 a 8), el número de piezas y la
  salida propios de cada uno, filtrados por jugabilidad. Se mantienen las reglas, la forma, el límite de jugadas y, a
  través de la semilla, la orientación de la imagen y los símbolos.
- **`worlds/grid/rules-check.ts`:**
  - `verdictAt` y `checkRulesAt` dan la respuesta del mundo a unas reglas en una posición: movimientos rechazados, el
    número de movimientos no predichos y si el final coincide;
  - `trueRulesSource`, solo para el operador, escribe las reglas verdaderas como las escribiría un aprendiz, relativas
    al tablero que se ve.
- **Las reglas verdaderas aciertan en todas las posiciones** de partidas al azar en 60 tableros de las semillas 22, 26 y 4
  (más de 1000 posiciones por semilla). Las reglas "de un solo tablero" (con el tamaño del tablero base fijo) fallan en
  más de 10 de los 60.
- **Hallazgo: solo se puede validar lo que el mundo muestra.** En la semilla 26, el otro bando tiene un movimiento que
  siempre lo sacaría del tablero (empieza en la última fila y ese vector baja), así que nunca ocurre. Unas reglas que lo
  omiten predicen exactamente lo mismo que las verdaderas y aprueban, y es correcto: son indistinguibles por
  observación. El test exige, en cambio, que olvidar un movimiento que sí ocurre falle.
- **Sesgo del filtro, a vigilar:** en la semilla 22 casi todos los tableros admitidos tienen 5 o 6 filas, porque en los
  más altos el juego al azar casi nunca gana por encierro. Aun así, los tableros difieren en ancho, piezas y salida.

## 8. Plan

| Fase | Contenido | Ficheros |
|---|---|---|
| G1 | Familia de tableros: `boardOf(spec, index)` con tamaño, salida y número de piezas propios, filtrado por jugabilidad | `lib/src/worlds/grid/family.ts` |
| G2 | El artefacto de reglas en el protocolo del explorador: parseo, comprobación sobre sus partidas, prompt sin pistas (§6) | `lib/src/learn/explorer.ts` |
| G3 | Prueba de reglas y veredicto por posición; aceptación exacta con confirmación ciega; `--quick` como en orbit (parar cuando System 2 da sus reglas por buenas) | `lib/scripts/run-grid.ts`, `lib/src/learn/rules-test.ts` |
| G4 | La fórmula en tableros de la familia y la regresión emparejada (hecha, §8.2) | `lib/scripts/run-grid.ts` |
| G5 | Tests de calibración de §7 y medidas del operador en el journal | `lib/test/grid-rules.test.ts` |

### 8.1 Decisión del 27/09/2026: sin artefacto de reglas en la cuadrícula

G2 y G3 no se implementan por ahora:
- **Filtraría información del entorno al prompt.** Pedir "qué cambios acepta el entorno y cuándo termina un episodio"
  ya le dice a System 2 qué forma tiene el mundo.
- **No hace falta para interpretar.** La estrategia se lee en las observaciones y las reglas que genera System 2: ahí
  está lo que entendió.
- **El caso de "ganar sin entender" no lo pide.** En ese run, System 2 no tenía instrumentos para plantear y contrastar
  hipótesis, y delegó el juicio en Jev sobre la observación en bruto: el modo delegado, que ya se sabe que no es
  interpretable. Sirve como referencia para comparar con la solución con instrumentos, y como prueba de que System 2
  se adapta y resuelve el mismo problema con estrategias muy distintas según las herramientas que tiene.

### 8.2 G4 hecha (27/09/2026): el protocolo del investigador en la cuadrícula

`lib/scripts/run-grid.ts` sigue el protocolo de §1.1, igual que orbit:
- **Sitios:** el tablero base es `lab1`; la familia son `place1`…`placeN` (`--family 4`), tableros de `boardOf` con el mismo
  id de mundo, así que un modelo sirve en todos. Cada sitio tiene su mundo, su dibujo, su observador y su evaluador;
  la caché de Jev es una sola, porque depende solo de lo que miden las observaciones.
- **Comprobación de cada ronda, en cada laboratorio:** episodios desde la salida habitual y desde `--variants` salidas
  nunca jugadas, y la **regresión emparejada**: los episodios de la comprobación anterior en ese laboratorio se vuelven a
  jugar con el modelo nuevo, con las mismas salidas y las mismas semillas del rival. System 2 recibe, por sitio, la
  puntuación de cada episodio y cuántos subieron o bajaron al volver a jugarlos. El modelo se sostiene en un sitio si
  todos sus episodios puntúan 1 y ninguno de los vueltos a jugar baja.
- **Validación** (`"validate": true`, `--validations 3`): en todos los tableros de la familia que no son laboratorio, con
  `--family-variants` salidas nuevas por tablero. Donde no se sostiene, el tablero pasa a laboratorio (`act` y `replay`
  solo en laboratorios). Si se sostiene en todos, dos conjuntos de `--confirm-boards` tableros nuevos deciden.
- **Rival:** aceptado contra un nivel de `--levels`, el rival pasa al siguiente y el protocolo sigue; aceptado contra el
  último, el run termina. `--quick` para cuando System 2 pide validar.
- **Ensayo con LLM falso y juez neutro** (semilla 4, rival aleatorio): valida, la confirmación ciega falla en un tablero,
  vuelve a validar en la ronda siguiente, se confirma y se acepta; en la semilla 22 un tablero donde no se sostiene pasa a
  laboratorio. Con el mismo modelo, volver a jugar la comprobación anterior da +0 −0, como debe.

`worlds/grid/rules-check.ts` (G1) se queda como instrumento del operador: comprueba la calibración de la familia de
tableros y puede servir para medir, solo en el journal, las reglas que System 2 describa.

## 9. Preguntas abiertas

1. ¿La familia de tableros puede cambiar también el número de filas entre las bandas de salida? Cambia cuánto dura la
   partida, pero no las reglas.
2. ¿Aceptar reglas y fórmula por separado (dos aceptaciones), o exigir las dos para terminar el run? Recomendado: por
   separado, registradas; el run termina cuando se aceptan las dos.
3. En el mundo físico, ¿se añade también la regresión emparejada? Allí equivale a volver a predecir los lanzamientos
   donde falló y comprobar que no empeoran los que acertaba.
