# SPEC · Delegar una investigación desde otra investigación

Estado (21/10/2026): **propuesto, sin implementar**.
Reformula [SPEC-BUSQUEDA-HIPOTESIS.md](SPEC-BUSQUEDA-HIPOTESIS.md). Se apoya en el investigador general,
[el canal de mensajes](SPEC-CANAL-MENSAJES.md) y [la investigación paralela](SPEC-INVESTIGACION-PARALELA.md).

## 1. La idea

**Un investigador puede abrir una rama para investigar una pregunta y recuperar sus resultados.** Otro investigador
recibe el encargo, herramientas, acceso autorizado al trabajo previo y presupuesto explícito. El solicitante puede
continuar mientras la rama investiga. Al terminar, recibe un mensaje con sus resultados y referencias al recorrido
completo; decide qué incorporar.

Desarrollar o cuestionar hipótesis es el primer caso de uso. También caben explorar una anomalía, contrastar un
supuesto o investigar una explicación rival. No se crea una clase de agente generador: se reutiliza el investigador
general con un encargo delimitado. La herramienta funciona sin senior; si existe, también puede utilizarla.

## 2. Abrir una rama

El solicitante formula la pregunta, señala antecedentes y propone recursos. El arnés comprueba disponibilidad,
reserva el presupuesto autorizado y crea una investigación vinculada a la solicitud. La rama recibe:

- El encargo y su autor; la explicación del solicitante no se convierte en verdad del mundo.
- Acceso documental al trabajo previo autorizado, con un punto de partida identificable.
- Herramientas para consultar ese trabajo, inspeccionar el mundo y experimentar en el montaje asignado.
- Límites, destinatario y contrato de entrega.

No se clona obligatoriamente el contexto del LLM, el proceso ni el estado físico del mundo. Se declaran por separado
las condiciones iniciales del laboratorio. La rama decide qué necesita leer; no se exige un resumen preparado por
el solicitante ni que este anticipe todas las referencias relevantes.

## 3. Herramienta del investigador

API ilustrativa, a integrar con las convenciones existentes:

```json
{
  "investigate": [{
    "delegate": {
      "question": "Investiga si el error persistente procede del instrumento o de un estado no representado del sistema.",
      "refs": ["investigation:r4.2", "model:r4"],
      "expected": "Direcciones que merezca explorar, qué las distingue y qué evidencia encontraste.",
      "budget": { "rounds": 3 }
    }
  }]
}
```

`question` es obligatorio; `refs` orienta la lectura, sin definir por sí solo todos los permisos. `expected` es
opcional. Los límites omitidos proceden de la configuración del run: no significan recursos ilimitados.
El texto del encargo no concede rutas, credenciales ni acceso adicional.

La respuesta inmediata devuelve ID estable, estado y recursos concedidos, o una negativa con motivo sin lanzar
trabajo. Consultar el estado y cancelar una rama propia pertenecen al mismo mecanismo. Una solicitud aceptada
consume un paso; la ejecución tiene su contabilidad propia y no oculta llamadas.

**`delegate` abre otra ejecución.** Pedir una dirección diferente o alternativas incompatibles son encargos escritos
en `question`, no herramientas ni modos especiales. Un encargo breve puede recibir menos presupuesto dentro del
mismo mecanismo; no requiere otro proponente.

### Sustitución completa

La implementación elimina `what_if`: herramienta, proponente aislado, prompts de junior y senior, flags, configuración,
cuotas, eventos, avisos, clasificación de trazas y pruebas específicas. No ha habido runs con esa herramienta:
no hay compatibilidad, alias, migración de registros ni soporte de replay histórico que mantener.

Retirar también las entradas de capacidades exclusivas de esa herramienta y actualizar documentación y ejemplos.
Los documentos anteriores no constituyen contratos que deban seguir soportándose. Conservar las capacidades generales
independientes, como cerrar rondas, leer memoria o registrar acciones. La eliminación no obliga a retirar esas piezas.

La interfaz nueva ofrece únicamente delegación para este propósito. Deshabilitarla deja al investigador trabajando
con sus herramientas ordinarias; no activa un proponente alternativo.

## 4. Acceso documental y laboratorio

Reutilizar lectores de memoria, documentos, artefactos y experiencia. La rama recibe acceso a la vista autorizada
del solicitante, no al diario bruto con información del operador. No accede a verdad oculta ni casos de examen.

Primera entrega: el trabajo del padre se consulta desde un corte fijado al aceptar la solicitud, con versiones
identificables. La comunicación continua queda para una extensión. Las referencias consultadas se registran.
La rama produce sus propios artefactos; no obtiene permiso para editar los del padre.

La experimentación utiliza un montaje propio de exploración mediante los adaptadores existentes. Se declara si
conserva parámetros, cambia de instancia o usa otro miembro de la familia. Sus observaciones conservan esa procedencia;
no se presentan como experimentos realizados en el montaje del padre.

No se interviene por defecto sobre un mundo mutable compartido. Si el laboratorio no puede proporcionar aislamiento,
se informa del acceso disponible y se rechaza un encargo experimental que no pueda cumplirse. No se degrada
silenciosamente a solo lectura ni se simula haber clonado el mundo. Se pueden construir instrumentos cuando las
herramientas habituales del laboratorio lo permitan.

## 5. Resultado y mensaje

La rama entrega un informe breve con referencias a su recorrido completo: qué investigó, qué encontró, direcciones
propuestas y sus diferencias, evidencia, alternativas descartadas e incertidumbres. Evidencia e interpretación
permanecen separadas. No se exige un número de hipótesis ni novedad positiva: fortalecer la original, refutar una
alternativa o no encontrar una dirección defendible son resultados válidos.

No se fuerza una propuesta de modelo para terminar el encargo. Reutilizar cierre y reflexión del investigador,
distinguiendo terminar la tarea de aceptar un modelo.

La entrega utiliza el canal existente de mensajes del operador, con tipo y remitente propios, por ejemplo
`research_result`, ID de delegación y run de origen. **Es una aportación delegada, no una orden del operador ni una
respuesta del entorno.** No exige obediencia, modifica `holds` ni reinicia validaciones.

El padre puede elegir direcciones, leer el trabajo, ignorarlo o abrir otro encargo. Adoptar un artefacto exige una
acción explícita y las evaluaciones habituales. La entrega ocurre entre operaciones como mensaje nuevo; no reescribe
contexto ni sistema. Si solicita el senior, recibe él el resultado y comunica al junior por su canal habitual.
El operador puede inspeccionar el registro sin tener que aprobar cada entrega ya autorizada.

## 6. Recursos y ciclo de vida

El operador habilita la capacidad y declara un fondo de delegación y límites por rama. El investigador decide cuándo
usarlo y puede pedir menos recursos. Primera entrega: una rama activa por solicitante y sin delegación recursiva
desde las ramas. Mayor concurrencia o profundidad será una condición explícita posterior.

El fondo es separado del presupuesto operativo del padre para permitirle continuar, pero entra en el coste total.
Reservar evita comprometer dos veces el mismo saldo. El remanente se libera tras conocer el cierre; gasto incierto
se registra como incierto. Tokens, tiempo y acciones conservan sus unidades y límites propios: rondas no equivalen
a un coste de inferencia fijo.

La entrega usa los recursos de delegación autorizados y no descuenta además otra unidad del cupo del senior.
Mostrar saldo, ramas y reservas al investigador. El finding distingue coste directo, delegado y total sin duplicarlo.

Estados mínimos: `accepted`, `running`, `completed`, `failed`, `cancelled`; registrar la entrega por separado.
Agotar presupuesto permite un informe parcial y no equivale a éxito científico. Si el padre termina normalmente,
solicitar el cierre de las ramas activas y conservar sus resultados parciales; no reabrir al padre por mensajes tardíos.
La cancelación del árbol se propaga. Esta política queda declarada, sin procesos huérfanos a cargo del operador.

## 7. Observabilidad, reanudación y reproducción

Antes de lanzar, registrar identidad, encargo, permisos, corte documental, laboratorio, configuración del hijo y
reserva. Después, identidad del run, estados, gasto, resultado y entrega. Cada rama conserva su diario de acciones,
respuestas y ediciones con los mecanismos habituales.

Identidades estables impiden que reanudar cree otra rama o repita un mensaje consumido. Si queda incierto si una
ejecución arrancó, reconciliar su identidad y registro antes de lanzarla otra vez. No prometer ejecución externa
exactamente una vez sin soporte para ello; conservar también las incertidumbres de inferencia.

El paquete incluye ramas y dependencias documentales necesarias. Replay reconstruye resultados y orden de entrega
sin lanzar nuevos investigadores. Las ramas se verifican con sus propios registros. Reejecutar con inferencias nuevas
es otro experimento, no reproducción del registro.

La configuración del generador declara delegación y recursos. Un resultado con trabajo delegado no se atribuye al
investigador aislado, aunque él decidiera solicitarlo.

## 8. Reutilización y alcance

| Mecanismo | Relación con la propuesta |
|---|---|
| Senior | Acompañamiento estratégico; posible solicitante, nunca dependencia |
| Investigador general | Ejecuta la rama con herramientas y encargo delimitado |
| Investigación paralela | Reutilizar ejecución, aislamiento y contabilidad; aquí la rama nace durante un run |
| Canal | Transporta el resultado con procedencia y sin autoridad de orden |
| Memoria y experiencia | Permiten consultar trabajo previo y recorrido de la rama |

La búsqueda observable de hipótesis ocurre dentro de estas investigaciones. Semillas, decisiones y contrastes pueden
preservarse en cuadernos y artefactos existentes. Un CRUD especializado de hipótesis o un grafo no son requisitos.
Tampoco se exige un algoritmo de diversidad, un selector Jev o un optimizador.

## 9. Primera entrega y evaluación

Cubrir inicialmente mundos de bucle común con montajes de exploración independientes. Declarar soporte por mundo;
los bucles propios y servicios externos requieren comprobar sus adaptadores.

Verificar con modelos simulados:

1. Un investigador sin senior solicita una rama y continúa trabajando.
2. La rama elige qué leer del registro autorizado y experimenta en su propio montaje.
3. Devuelve alternativas o un resultado negativo con referencias.
4. El padre recibe el mensaje una sola vez y consulta el recorrido completo.
5. El senior puede realizar el mismo encargo sin ser requisito del mecanismo.
6. Límites, fin del padre, cancelación, fallos y reanudación conservan recursos e identidades.
7. El paquete se verifica sin nueva inferencia ni acceso a información oculta.
8. No queda exposición ni ejecución de la herramienta sustituida, ni adaptadores de compatibilidad; las pruebas y
   ejemplos usan el contrato nuevo.

Después comparar investigación sin delegación y con delegación con presupuesto total comparable. Separar el
efecto de más recursos del de explorar independientemente. Evaluar resultados del mundo e inspeccionar trayectorias;
contar hipótesis no demuestra progreso.

**La capacidad general es delegar una pregunta investigable y recuperar su trabajo. Generar hipótesis es su primer uso.**
