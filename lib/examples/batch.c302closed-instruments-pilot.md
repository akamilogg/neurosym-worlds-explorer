# c302: piloto emparejado de instrumentos propios

Desde `lib/`, con el servicio de c302 reiniciado (para que cargue el último worker) y la configuración de modelos habitual:

```powershell
.\lab_two_tier_reasoning.ps1 batch examples\batch.c302closed-instruments-pilot.json
```

Dos runs de la faceta de señales, **idénticos salvo una cosa**: el primero puede escribir instrumentos propios
(SPEC-INSTRUMENTOS-PROPIOS) y el segundo lleva `--no-instruments`. Comparten:
- la misma versión del código y la semilla 1;
- 16 rondas y 5 millones de tokens del junior, con su cierre aunque se agote (SPEC-INVESTIGADOR-ASISTIDO §14.9);
- `--own-tests 2`, memoria selectiva y fuentes;
- la misma tarea, que no menciona los instrumentos;
- un senior cada uno, con el mismo presupuesto de órdenes.

`concurrency: 1` los ejecuta uno tras otro contra el mismo servicio.

**Qué se compara** (es un piloto: una semilla, no concluye):
- **El R² del check por ronda:** ¿deja de oscilar sin tendencia con instrumentos? ¿Llega más alto?
- **Si algún modelo se sostiene,** y en qué ronda.
- **Con instrumentos:** cuántos registra y usa, y si los parámetros del modelo final salen de un uso (`instrument_used`)
  o se escriben a mano.
- **El método:** `view`, `measure` y `table` frente a usos de instrumentos.
- **Los tokens hasta el final,** y la nota de hallazgos del calificador.

Si el piloto apunta a algo, lo siguiente son runs emparejados con varias semillas (SPEC-INSTRUMENTOS-PROPIOS §10).
