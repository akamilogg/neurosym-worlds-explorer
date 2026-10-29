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

Si falla alguna, se corrige en `junior_worker.py` o `junior_verify.py`: el resto del contrato no cambia.
