# c302: A investiga señales; B consulta A e investiga navegación

Desde `lib/`, con el servicio de c302 preparado:

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.c302closed-staged-n2.json
```

Ese lanzador está configurado actualmente con Luna y razonamiento `high` en junior y senior. El JSON no fija modelos:
se puede usar con otro lanzador que configure ambos roles. Preparar este batch no lo ejecuta.

- A: `closed-signals-s1`, evaluación de señales, pareja propia de junior y senior.
- B: `closed-navigation-s1`, evaluación de navegación, otra pareja y un historial nuevo.
- `concurrency: 1` ejecuta A antes que B. B recibe la referencia al journal terminado de A mediante `--experience`,
  `--experience-mode meta` y `--experience-scope all`; el lector existente oculta la información del operador.
- No se copia ni resume A, ni se instala su modelo automáticamente. El junior de B consulta `exp1` y decide qué usar.
  Su senior puede revisar esas lecturas en el registro de B; su lector actual no abre directamente los instrumentos
  `experience` del junior.
- Cada investigación dispone de 16 rondas, 300 minutos y 5 millones de tokens del junior; hasta 16 órdenes del senior
  y 2 pruebas propias requeridas. El coste del senior se contabiliza aparte.
- A no tiene que haber sido aceptada: una investigación terminada con resultados parciales también es documentación
  útil para B. Una interrupción sin cierre no sirve como referencia y B se rechaza antes de empezar su investigación.

El lote tiene un identificador nuevo y no modifica los resultados ni los lotes anteriores. Se evalúa cada investigación
por su faceta. El lote alternativo `batch.c302closed-unified-n2.json` conserva la condición de evaluación conjunta.
Este batch de dos investigaciones no añade un tercer run ni una evaluación conjunta automática.

## Reanudación

B se refiere a A como `@run:closed-signals-s1`: el lote lo resuelve, al arrancar B, al journal con el que terminó A en este
mismo lote (con su sufijo si se reanudó: `.r1.json`, etc.). No hay rutas escritas a mano, así que cambiar el ID del lote
no rompe la referencia. Si A no ha terminado, B no arranca y el lote lo dice.

Una vez que B haya empezado, conserva el journal de A sin modificarlo: el arnés comprueba su hash al reanudar B.

Un run que falló antes de escribir su journal (por ejemplo, por un argumento) se vuelve a empezar al relanzar el lote,
no se reanuda.
