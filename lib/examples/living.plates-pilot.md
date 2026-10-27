# Mundo vivo en `plates@1`: primera prueba real con investigadores LLM

Desde `lib/`, con la configuración de modelos habitual (el lanzador lleva las claves del LLM y del Judge):

```powershell
.\lab_two_tier_reasoning.ps1 live examples\living.plates-pilot-pair.json
.\lab_two_tier_reasoning.ps1 live examples\living.plates-pilot-solo.json
```

Cada sesión escribe en `runs/plates-s11-<fecha>/`:
- `session.session.json`: el plan y cómo terminó cada investigador;
- `session.world.jsonl`: el diario del mundo;
- `session.<id>.json`: el diario de cada investigador.

Se siguen en la consola, en el panel «Mundo vivo», con dos vistas: lo que percibió cada investigador y la del auditor.

Al terminar, se empaquetan y se verifican sin red:

```powershell
.\lab_two_tier_reasoning.ps1 pack ..\runs\plates-s11-<fecha>\session.session.json
.\lab_two_tier_reasoning.ps1 verify ..\runs\plates-s11-<fecha>-session.session-package
```

**Qué pregunta** (SPEC-ACONTECIMIENTOS-DEL-MUNDO §17.2). Es un piloto descriptivo, no una comparación con valor
estadístico; un resultado negativo bien fundamentado también vale. Se trata de seguir dos cosas hasta el final:
- **una sorpresa**, hasta que se contrasta y alguien decide algo;
- **una comunicación**, hasta su efecto.

La infraestructura queda acreditada aunque nadie resuelva el mundo.

**El mundo.** Una placa de 4×6 pozos. Lo que se percibe:
- nutriente y colonia en cada pozo;
- marcas, que no tienen ninguna consecuencia.

Lo que no se percibe, sólo sus consecuencias:
- leyes fijadas por la semilla 11: crecimiento, hambre y siembra entre vecinos;
- la contaminación, que llega sola de vez en cuando.

Los checks se hacen en realizaciones reservadas: sin llegadas de contaminación y con dos pozos contaminados desde el
principio.

|  | Pareja (`pair`) | Solo (`solo`) |
| --- | --- | --- |
| Investigadores | `a` y `b`: 10 rondas, 6 pasos y 3 actos por ronda, 2M de tokens cada uno | Sólo `a`, con el mismo presupuesto |
| Otros actores | `rival`: adversario reactivo que drena los pozos que vio alimentar y los que le nombran en un mensaje | El mismo |
| Comunicación | 2 mensajes por ventana y miembro, de hasta 600 caracteres; directos o globales; compartir material propio | Ninguna |
| Vigilantes y reactividad | Hasta 2 vigilantes por investigador; `wait` con `wake_on` (lecturas y mensajes), hasta 4 despertares | Igual, sin mensajes |
| Programas del operador | Contaminación en el tick 24 y en el 72 (`sensors_only`). Si la señal de checks de `a` se estanca 3 rondas, pulso de nutriente anunciado | Los mismos |
| Reloj | Ventanas de 3 ticks, horizonte 240; una ventana espera a los investigadores hasta 15 min | Igual |

**Qué mirar:**
- **Las contaminaciones** (ticks 24 y 72). La vista del auditor las muestra como «happened»; nadie avisa de ellas.
  - ¿Alguien nota que una colonia cae de dos en dos?
  - ¿Registra un vigilante, se despierta, limpia, formula una hipótesis o lo contrasta con un acto?
  - ¿O lo ignora? Ignorarlo también es válido.
- **La comunicación entre `a` y `b`.** ¿Se escriben? ¿Comparten episodios? ¿Cambia lo que hace uno por lo que le dijo el
  otro?
  - Si alguno escribe al `rival` nombrando pozos, el rival los drena: es un efecto físico de una comunicación.
- **El estancamiento de `a`.** Si se da, el pulso anunciado llega como anuncio del operador: queda etiquetado como
  `reactive/operator_fixed` y no cuenta como ayuda.
- **La pareja frente al solo.** Con una realización de cada, es sólo una descripción: qué abre la comunicación que no abre
  el solo.

**Qué no hay en este piloto:**
- senior: las sesiones compartidas todavía no lanzan agentes operadores;
- delegación: no se declara en el manifiesto;
- reloj en tiempo real.

**Lo que cuesta:** como mucho 2M de tokens por investigador, es decir, hasta 4M en la pareja y 2M en el solo, más las
llamadas al Judge.
