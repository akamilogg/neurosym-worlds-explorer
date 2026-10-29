# El junior en su máquina: montaje y prueba real de MA1

Guía de [SPEC-METAPOLITICA-APRENDIZAJE](../../SPEC-METAPOLITICA-APRENDIZAJE.md) §12 y MA1. El arnés no instala ni
configura nada del sistema: aquí sólo se dice qué debe haber y cómo comprobarlo.

## 1. En la máquina del operador

El intermediario de proveedores guarda las claves y paga cada llamada de una bolsa. Corre aquí, nunca en la máquina del
junior.

1. Copia `junior.proxy.example.json`, pon la URL de cada proveedor, las bolsas y el nombre de la variable de entorno que
   tiene cada clave (`key_env`).
2. Elige un token por cliente y guarda en `clients` sólo su SHA-256:
   `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>`
3. Arráncalo en la dirección que ve la máquina del junior:
   `node --experimental-strip-types scripts/provider-proxy.ts --config proxy.json --host <dirección> --port 18800`

## 2. En la máquina del junior

1. **Montaje del operador:** copias fuera de la máquina, instantáneas del sistema de archivos, red de salida limitada al
   intermediario y a lo imprescindible, cuotas de disco y GPU. Ninguna clave de proveedor en el entorno.
2. **Comprobación:** copia `junior.machine-check.example.json` con tus comandos reales. Cada pieza (`backups`,
   `snapshots`, `keys`, `proxy`, `egress`, `limits`) necesita al menos una comprobación.
   `lab junior check junior.machine-check.json` debe decir `the machine is ready`; si no, no empieza ninguna investigación.
3. **Python con Qwenputer:** un entorno con `chipformer` de la rama `rv-store` y sus dependencias. `JUNIOR_PYTHON` o
   `--python` apuntan a ese intérprete.

## 3. El paquete

1. Guarda cada pieza en el almacén de blobs y anota su hash:
   - `lab junior store <checkpoint Filesystem> --blobs <blobs>` → `tree <hash>` (el modelo base)
   - `lab junior store <firmware.elf> --blobs <blobs>`, y lo mismo con `tokenizer.json`, la plantilla de chat, el
     driver (`chipformer/rv`, como árbol) y `src/junior/junior_verify.py`.
2. Escribe `package.json` (`junior-package@1`): `base`, `prompt`, `execution` con esos hashes, `circuit` (el
   `chipformer.json` servido), `precision`: `bf16`. La primera versión arranca sin memoria (`memory` con los dos a `null`)
   y con `temperature` 0: el driver sólo decodifica de forma voraz.
3. `lab junior package package.json --blobs <blobs>` debe decir `closed`.

## 4. La prueba real de MA1

1. **Recursos:** `lab junior probe package.json --blobs <blobs> --python <python> --lengths 2048,8192,32768 --work <dir>`.
   Mide la memoria máxima de GPU por longitud de contexto. Las cifras publicadas no se dan por buenas.
2. **Servidor:** `node --experimental-strip-types scripts/junior-server.ts --root <sesiones> --blobs <blobs> --python <python>`.
3. **Una sesión con memoria:** abre una sesión y haz dos preguntas. En la primera pide que guarde un dato con `put`; en la
   segunda, que lo recupere con `get`. Después abre otra sesión que continúe desde la primera (`continues`) y vuelve a
   preguntar: la memoria debe venir del último estado publicado.
4. **Verificación sin modelo:**
   `lab junior verify <sesiones>/sessions/<id>.jsonl --blobs <blobs> --python <python> --backend qwenputer --firmware <firmware.elf> --tokenizer <tokenizer.json>`
   debe decir `verified`, con la memoria de cada respuesta reconstruida por la referencia.

Lo que esta prueba confirma por primera vez, y que aquí no se ha podido ejecutar:

- que la sesión de referencia del almacén acepta un almacén precargado (`StoreSession(..., dev=...)`) y sigue bloqueada
  token a token contra el circuito;
- que repetir en el verificador las mismas llamadas a `qwen()` reproduce el mismo flujo;
- que el `pickle` del dispositivo de referencia da los mismos bytes en el trabajador y en el verificador.
- que la lectura de la memoria como archivos (`render`: `Device.names()` y `Device.text()` del almacén, decodificados
  con el tokenizer del paquete) da los nombres y textos escritos; de ella dependen la palanca de memoria inicial y
  `publish_memory` (MA3).
- que el simulador de memoria del maestro (`memory_call`: `StoreSession.call(op, name, text)` sobre una copia del gemelo,
  su respuesta leída con `printed()`) responde como el circuito; de él depende la destilación desde un corte (MA4).
- el entrenamiento (MA5, `junior_train.py`): que el patrón de módulos de peft encuentra las proyecciones de Qwen3.5 en
  las capas pedidas y ninguna del circuito; que una QLoRA deja sin cuantizar las capas del circuito; y que la prueba de
  capacidad mide el pico real en la GPU de entrenamiento;
- servir un adaptador (`apply_adapter`: el LoRA sumado en su sitio a los pesos de Qwen tras cargar `RvChat`) y que la vista
  rápida del driver lo ve; y que la suite de validez de verdad ejercita cálculo, `put`, `get`, `delete` y una memoria
  restaurada, con el resumen de los parámetros del circuito igual al de la base.
- tras la revisión externa del 29/10: que el driver se importa desde la carpeta del paquete (`load_driver`) y que lo
  que el trabajador declara haber cargado (tokenizer, plantilla, firmware, ficheros del driver, `chipformer.json`,
  precisión) coincide con el paquete; que el plazo declarado corta la generación desde dentro (`generate` llama a
  `lock.qwen` por cada token) y devuelve el prefijo como `limit_reached`; que la comprobación del snapshot neuronal
  (`neural_check`: legible como snapshot del almacén, con filas exactamente cuando el gemelo tiene archivos) se afina con
  la correspondencia real filas–fragmentos; y que `StoreSession.call_tokens` da la secuencia que el junior emite para
  una llamada, la que se entrena como decisión.

Si falla alguna, se corrige en `junior_worker.py` o `junior_verify.py`: el resto del contrato no cambia.

## 5. La línea base (MA2)

1. **Cortes:** elige preguntas de runs de desarrollo y toma su hash: `lab junior cut <run.json> <pregunta>`. La pregunta
   cuenta las de System 2 desde 0. El run se reanuda desde su propio registro hasta esa pregunta; lo que se le pregunta
   ahí es el prefijo de la sonda.
2. **Manifiesto:** copia `junior.competence.example.json`. Cada componente de sondas recibe el mismo número de sondas
   de cada mundo; los grupos (el linaje del run) no se reparten entre particiones. `lab junior manifest <manifiesto>`
   lo valida y vuelve a tomar cada corte: si algo no cuadra, no corre nada.
3. **Medida:** con el servidor del junior en marcha,
   `lab junior evaluate <manifiesto> package.json --blobs <blobs> --server http://127.0.0.1:18700 --dir <evaluación>`.
   Corre las investigaciones como ensayos de M2 y las sondas en sus cortes, y deja la evaluación en
   `<evaluación>/evaluations/`. Lo ya medido no se repite.
4. **Comparar dos juniors:** `lab junior promote <manifiesto> <evaluación de referencia> <evaluación candidata>` aplica
   `paired-cases@1` desde lo medido, sin modelos.
5. **El mundo del investigador fuerte:** `lab start junior --manifest <manifiesto> --package package.json --blobs <blobs>
   --server http://127.0.0.1:18700 --work <dir> --evaluations 10`, con el modelo fuerte como System 2. Su exploración es
   la línea base; cambia `prompt.md` y `decoding.json`, evalúa versiones y pone una adelante para que se compare con la
   referencia.
