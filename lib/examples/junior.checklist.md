# Lista de comprobación: Qwenputer en su máquina, de MA1 a la línea base

Para ejecutar en orden, marcando cada casilla. El detalle de cada paso está en [junior.setup.md](junior.setup.md) (§ entre
paréntesis). Aquí van las órdenes, lo que debe salir y qué hacer si no sale.

Hay dos máquinas: **la del operador** (esta, con las claves) y **la del junior** (2×3090, Linux). Ninguna clave de
proveedor va a la del junior.

Al final, una tabla dice qué traer para analizar. Si algo falla, se para ahí: lo que viene después depende de ello.

## 0. Antes de empezar

- [ ] **El mismo commit en las dos máquinas.** `git log --oneline -1` debe dar lo mismo en ambas (a partir de `99bf1fa`).
- [ ] **Node 22 o posterior** en las dos (`node --version`).
- [ ] **Un alias `lab`** en la máquina del junior. Las órdenes de abajo lo usan; ejecútalas desde `lib/`:

  ```bash
  alias lab='node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/lab.ts'
  ```

- [ ] **Carpetas de trabajo**, fuera del repo y con espacio para checkpoints:

  ```bash
  export J=/ruta/junior
  mkdir -p $J/blobs $J/sesiones $J/work $J/evaluacion
  ```

## 1. Máquina del operador: el intermediario (§1)

- [ ] **La configuración.** Copia `examples/junior.proxy.example.json` a `proxy.json` y pon:
  - los proveedores y las bolsas;
  - `key_env`, el nombre de la variable que tiene cada clave. Nunca la clave misma.
- [ ] **Un token para la máquina del junior.** En `clients` va sólo su SHA-256:

  ```bash
  node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>
  ```

- [ ] **Arrancarlo** en una dirección que vea la máquina del junior:

  ```bash
  node --experimental-strip-types scripts/provider-proxy.ts --config proxy.json --host <dirección> --port 18800
  ```

- [ ] **Desde la máquina del junior, se ve.** Por ejemplo, `curl http://<dirección>:18800/` responde algo, aunque sea un
  error: lo que importa es que conecta.

## 2. Máquina del junior: montaje y comprobación (§2)

- [ ] **El montaje del operador:**
  - copias de seguridad fuera de la máquina e instantáneas del sistema de archivos;
  - red de salida sólo hacia el intermediario y lo imprescindible;
  - cuotas de disco y GPU;
  - ninguna clave en el entorno: `env | grep -i key` no muestra ninguna.
- [ ] **La comprobación.** Copia `examples/junior.machine-check.example.json` a `machine-check.json` con tus órdenes
  reales. Cada pieza necesita al menos una: `backups`, `snapshots`, `keys`, `proxy`, `egress` y `limits`.

  ```bash
  lab junior check machine-check.json
  ```

  Debe decir **`the machine is ready`**. Si no, no empieza nada.
- [ ] **Python con Qwenputer.** `chipformer` de la rama `rv-store`, con sus dependencias (torch con CUDA, transformers;
  peft para entrenar después).

  ```bash
  export JUNIOR_PYTHON=/ruta/al/python
  $JUNIOR_PYTHON -c "import chipformer, torch; print(torch.cuda.device_count())"
  ```

  Debe imprimir `2`.

## 3. El paquete (§3)

- [ ] **Guarda cada pieza y anota su hash:**

  ```bash
  lab junior store <carpeta del checkpoint> --blobs $J/blobs
  ```

  Responde `tree <hash>`: el modelo base. Haz lo mismo con:
  - el firmware;
  - `tokenizer.json`;
  - la plantilla de chat;
  - el driver (`chipformer/rv`, como carpeta);
  - `src/junior/junior_verify.py`.
- [ ] **Escribe `package.json`** (`junior-package@1`):
  - `base` y `execution` con los hashes;
  - `circuit`: el `chipformer.json` que se sirve;
  - `precision`: `"bf16"`;
  - `memory`: `{"neural": null, "twin": null}`;
  - `decoding` con `temperature` 0.
- [ ] **Comprueba que está cerrado:**

  ```bash
  lab junior package package.json --blobs $J/blobs
  ```

  Debe decir **`closed`**. Anota el hash de ejecución que imprime: es la `reference` del manifiesto (§5).

## 4. La prueba real de MA1 (§4)

- [ ] **Recursos.** Mide la memoria máxima de GPU por longitud de contexto. Las cifras publicadas no se dan por buenas:

  ```bash
  lab junior probe package.json --blobs $J/blobs --python $JUNIOR_PYTHON --lengths 2048,8192,32768 --work $J/work
  ```

  Guarda la salida.
- [ ] **El servidor**, en una terminal propia:

  ```bash
  node --experimental-strip-types scripts/junior-server.ts --root $J/sesiones --blobs $J/blobs --python $JUNIOR_PYTHON --backend qwenputer
  ```

  Debe decir `junior server on http://127.0.0.1:18700 (qwenputer; ...)`.
- [ ] **La sesión con memoria**, en otra terminal:

  ```bash
  node --experimental-strip-types scripts/junior-smoke.ts --server http://127.0.0.1:18700 --package package.json --root $J/sesiones
  ```

  Hace tres preguntas:
  1. guardar un dato con `put`;
  2. recuperarlo en la misma sesión;
  3. recuperarlo en otra sesión que continúa la primera.

  Al final lee la memoria como ficheros. Lo que debe verse:
  - en 1, una llamada `put`;
  - en 2 y 3, una llamada `get` que devuelve el dato;
  - en «the memory as files», el dato.

  Si el junior no usa su memoria con estas preguntas, adapta `--fact` y el texto al formato de llamada de Qwenputer.
  Lo que se prueba es la cadena, no la redacción.
- [ ] **La verificación sin modelo**, para cada sesión que imprime el script:

  ```bash
  lab junior verify <sesión>.jsonl --blobs $J/blobs --python $JUNIOR_PYTHON --backend qwenputer --firmware <firmware.elf> --tokenizer <tokenizer.json> --driver $J/work/drivers/<hash del driver> --base $J/work/packages/<hash de ejecución>/base
  ```

  Debe decir **`verified`**. Si dice `NOT verified: incomplete`, falta `--base` o la GPU.

Esta prueba confirma por primera vez diez cosas que sólo se han probado con imitaciones (§4, la lista). Si falla alguna,
la salida dice cuál. Se corrige en `junior_worker.py` o `junior_verify.py`; el contrato no cambia.

## 5. La línea base (MA2, §5)

- [ ] **Los cortes.** Elige preguntas de runs de desarrollo de los mundos de la escalera y toma el hash de cada corte. La
  pregunta cuenta desde 0.

  ```bash
  lab junior cut <run.json> <pregunta>
  ```

- [ ] **El manifiesto.** Copia `examples/junior.competence.example.json`:
  - `reference`: el hash de ejecución del §3;
  - `promotion.procedure`: **`paired-cases@2`**, que es el de la medida en vigor (SPEC-VALIDEZ-MEDIDA §4.1);
  - **cuántos casos.** Cada componente necesita los suficientes en desarrollo para poder decidir: 2⁻ⁿ ≤ 0,05 / nº de
    componentes. Con 4 componentes, **al menos 7 casos por componente**. El ejemplo tiene 1 y se rechazaría;
  - las sondas de un componente, en el mismo número por mundo;
  - un grupo (el linaje de un run) en una sola partición.
- [ ] **Validarlo:**

  ```bash
  lab junior manifest manifiesto.json
  ```

  Vuelve a tomar cada corte. Si algo no cuadra, o la medida no puede decidir, lo dice y no corre nada.
- [ ] **Medir la referencia**, con el servidor en marcha:

  ```bash
  lab junior evaluate manifiesto.json package.json --blobs $J/blobs --server http://127.0.0.1:18700 --dir $J/evaluacion
  ```

  La evaluación queda en `$J/evaluacion/evaluations/`. Lo ya medido no se repite: si se corta, se relanza igual.

Con esto hay línea base. Lo siguiente (§5.5) es el investigador fuerte mejorando al junior: `lab start junior ...`.

## Qué traer para analizar

| Paso | Qué |
| --- | --- |
| §2 | La salida de `lab junior check` |
| §3 | La salida de `lab junior package` (el hash de ejecución) |
| §4 | La salida de `probe`, la de `junior-smoke.ts`, la de `verify` de cada sesión y el log del servidor si algo falla |
| §5 | La salida de `lab junior manifest` y la evaluación (`$J/evaluacion/evaluations/*.json`) |

Ni claves ni tokens: el SHA-256 basta.

## Lo que no está en esta lista

- **La confirmación con casos reservados** (§6). Va después de que haya un candidato que confirmar.
- **El aislamiento para programas libres:** `lab junior isolation` (§9).
- **La prueba de aislamiento de la GPU.** No existe todavía: la exigen WE7 (`deletion@1`) y los programas de método con
  GPU, y hay que escribirla antes de ejecutarlos.
