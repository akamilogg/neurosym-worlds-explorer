# 3SUM con antecedentes de estancamiento: delegación normal frente a búsqueda evolutiva

Desde `lib/`, con la configuración de modelos habitual (el mundo de artefactos no necesita servicio):

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.artifacts-threesum-stall.json
```

**Qué pregunta:** ¿aporta algo la búsqueda evolutiva frente a la delegación normal, ante un estancamiento conocido? Que
el investigador sepa cuándo usarla es otra pregunta, para después (`batch.artifacts-threesum-evolve.json`, sin
invitación).

**No son continuaciones de un mismo estado congelado.** Son dos investigaciones nuevas de `threesum-subquadratic@1`, que
se juzga por cómo crece el tiempo (SPEC-MUNDO-ARTEFACTOS §18.12). Parten de su base cuadrática y tienen como antecedentes
los runs 6 y 7 de 3SUM:
- esos runs tenían `config.artifact: "threesum"`, aunque sus carpetas se llamen `subquadratic`: se juzgaban por
  velocidad frente a la base cúbica, no por crecimiento;
- se estancaron en soluciones cuadráticas, y sus programas para rangos acotados no resolvieron el rango amplio;
- sus aceptaciones históricas no acreditan nada frente al criterio actual.

Su experiencia sigue siendo pertinente: lo que probaron, lo que falló y por qué. Por eso no se hacen runs nuevos sin
evolución.

|  | A, delegación normal | B, búsqueda evolutiva |
| --- | --- | --- |
| Punto de partida | La base cuadrática de `threesum-subquadratic@1` | La misma |
| Experiencia | Los diarios de los runs 6 y 7 (`exp1`, `exp2`, modo `meta`), legibles también por sus ramas con las mismas etiquetas | Los mismos, también para la consolidación |
| Herramientas | Investigación y delegación normal | Las mismas, más la búsqueda evolutiva |
| Recursos | Fondo de 1,2M para ramas, 600k por rama, 16 rondas, 4M de tokens del junior | Los mismos; la mutación y la consolidación salen del mismo fondo |
| Encargo (ronda 2) | Delegar una investigación para superar el atasco, señalando dos programas de esos runs (`refs`) | El mismo, como búsqueda evolutiva con esos dos programas como semillas |

**Lo que hace la comparación justa:**
- las dos reciben las mismas investigaciones anteriores y los mismos dos programas, y sus ramas pueden abrir esos
  diarios. Así, una diferencia no puede venir de que B tuviera más antecedentes;
- A conserva la delegación normal, para comparar cómo se busca y no si hay otro investigador;
- en las dos el encargo es una intervención del operador para probar la herramienta, y cuenta como ayuda en ambas.

**Los dos programas:**

| ID | Mecanismo en el código | En su run |
| --- | --- | --- |
| `exp:exp1#artifact:cbdcdfec79540eab` | Convolución por cuadrado de enteros empaquetados, con la corrección de pares diagonales | Run 6, aceptado frente a la base cúbica |
| `exp:exp2#artifact:37269ec87e0eda7a` | Bitset de rango acotado | Run 7, aceptado frente a la base cúbica |

- Es una convolución y un bitset. Dejo fuera `85f8d90d8f471dcf`, de la que procede `cbdcdfec`: es la misma convolución
  y cambia sobre todo el tratamiento de los pares diagonales.
- Ninguno se califica de mejor o peor: eso lo dirán las medidas de esta rama.
- En las cargas de exploración, de rango amplio, los dos toman su alternativa de dos punteros, porque sus condiciones de
  rango acotado no se cumplen. Sus mecanismos están en el código, pero no se manifiestan al principio en esas cargas.
  Son material para transformar y recombinar, no dos comportamientos distintos de partida.
- En B, cada semilla se vuelve a medir en la rama y es raíz de su propio linaje. Los reinicios se conservan.

**Presupuesto de la búsqueda:**
- 60 evaluaciones: 54 para buscar y 6 protegidas para confirmar lo que se exporta, que como mucho son 6 candidatos.
- Con 30, la recuperación por estancamiento (tras dos bloques de 10 evaluaciones sin progreso) apenas tenía margen para
  actuar. Con 54 lo tiene, pero que actúe, y cuántas veces, depende del progreso registrado y de los demás límites
  (intentos, tokens, tiempo).
- 1 workload por tamaño.
- Hasta 1 h de máquina y 3 h de pared por rama, que son los valores por defecto.

**Qué se busca: una cadena observable, no la solución completa:**
1. Aparece una alternativa con un mecanismo o supuesto distinto.
2. Se ejecuta un experimento que la distingue de lo anterior.
3. La alternativa recibe desarrollo suficiente para saber si abre una oportunidad.
4. El investigador la adopta, la modifica o la descarta con evidencia.

**La señal especialmente interesante:** una variante inicialmente inferior sobrevive y da lugar a un descendiente útil
que la investigación anterior no había alcanzado. Por ejemplo, una semilla de rango acotado adaptada al rango amplio.

**Dónde mirarlo:**
- En B, la rama evolutiva (`run.branches/`):
  - en `.search.jsonl`, los linajes desde cada semilla y desde los reinicios, y si una variante peor tuvo descendencia
    que mejoró (`candidate` con sus `parents` y `roots`, `development_admitted`, `repair_*`);
  - en el manifiesto, las élites y las raíces;
  - la consolidación;
  - en K1, `cost.tokens.evolutionary`: exportados, adoptados y aceptados.
- En A, la rama normal: qué dirección propuso, si leyó los dos programas, y con qué evidencia.
- En los dos: qué hizo el padre con lo que recibió (adoptar, contrastar, descartar), y el coste completo frente al mismo
  fondo.

Una semilla o una ejecución no bastan para concluir nada: esto es un piloto descriptivo.
