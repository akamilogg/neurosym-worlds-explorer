# SPEC · El modelo del mundo: descubrir las reglas y validarlas como un investigador

**Fichero:** `SPEC-MODELO-DEL-MUNDO.md`
**Estado (26/09/2026):** propuesta. La parte del mundo físico está implementada (`SPEC-MUNDO-FISICO.md` §8.4–8.5,
commit `9656ef2`); la de la cuadrícula, sin implementar.

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

**El veredicto, por posición.** Son hechos que el mundo da al contrastar la predicción, lo mismo que haría `try`
sistemáticamente:
- los movimientos que predijo y el mundo **no permite** (cuáles son: son afirmaciones suyas);
- **cuántos** movimientos permite el mundo que no predijo. El número, no la lista, para no darle los movimientos hechos;
- si el final predicho coincide con el real, y cuál fue el real, porque el final de una partida siempre se ve.

**Después de la prueba,** esos tableros y partidas pasan a ser suyos para estudiarlos, con `view`, `try` y `play`.

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

- **El prompt dice** que el juego se juega en una familia de tableros con las mismas reglas. Es la premisa, no las reglas.
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

## 8. Plan

| Fase | Contenido | Ficheros |
|---|---|---|
| G1 | Familia de tableros: `boardOf(spec, index)` con tamaño, salida y número de piezas propios, filtrado por jugabilidad | `lib/src/worlds/grid/family.ts` |
| G2 | El artefacto de reglas en el protocolo del explorador: parseo, comprobación sobre sus partidas, prompt sin ejemplos del entorno | `lib/src/learn/explorer.ts` |
| G3 | Prueba de reglas y veredicto por posición; aceptación exacta con confirmación ciega | `lib/scripts/run-grid.ts`, `lib/src/learn/rules-test.ts` |
| G4 | La fórmula en tableros de la familia y la regresión emparejada | `lib/scripts/run-grid.ts` |
| G5 | Tests de calibración de §7 y medidas del operador en el journal | `lib/test/grid-rules.test.ts` |

## 9. Preguntas abiertas

1. ¿La familia de tableros puede cambiar también el número de filas entre las bandas de salida? Cambia cuánto dura la
   partida, pero no las reglas.
2. ¿Aceptar reglas y fórmula por separado (dos aceptaciones), o exigir las dos para terminar el run? Recomendado: por
   separado, registradas; el run termina cuando se aceptan las dos.
3. En el mundo físico, ¿se añade también la regresión emparejada? Allí equivale a volver a predecir los lanzamientos
   donde falló y comprobar que no empeoran los que acertaba.
