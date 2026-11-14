# 3SUM con fuentes externas en lista blanca

Desde `lib/`, con la configuración de modelos habitual (junior gpt-6-luna, senior gpt-6-sol, esfuerzo alto) y el
extractor de PDF declarado:

```powershell
$env:PDF_EXTRACTOR = 'node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/pdf-extractor.ts'
.\lab_two_tier_reasoning.ps1 batch examples\batch.artifacts-threesum-sources.json
```

`scripts/pdf-extractor.ts` usa `pdftotext`, que viene con Git para Windows (`PDFTOTEXT` si no está en el PATH). Sin
extractor, los artículos de arXiv en PDF responden `unsupported_media` y sólo se leen sus páginas HTML.

**Qué pregunta:** cuando la información sobre una solución existe en fuentes que el investigador puede leer, ¿la
encuentra, la entiende, la adapta a este mundo, la aplica y la valida? Se juzga el **método**, no el veredicto. Por cómo
está planteada `threesum-subquadratic@1` (pendiente log-log entre n = 2000 y 8000, en Python), es probable que ninguna
versión pase: los algoritmos publicados por debajo de n² ganan factores logarítmicos con constantes grandes, y empaquetar
bits con un ancho fijo sólo cambia la constante.

**Una sola diferencia con su referencia.** Es `threesum-stall-A-delegation` (lote `artifacts-threesum-stall`) con
fuentes externas. Todo lo demás es igual: mismos argumentos, semilla, experiencia (runs 6 y 7), mensaje de la ronda 2,
senior y presupuestos. `test/external-pages.test.ts` comprueba que el lote es ese run más las fuentes.

| Fuentes | Quién | Cómo |
| --- | --- | --- |
| `en.wikipedia.org`, `arxiv.org`, `cp-algorithms.com`, `docs.python.org` | junior, senior y ramas | Sin buscador: abren una URL que conocen o que enlaza una página leída |
| 60 lecturas y 100 MB | junior; el senior, las mismas en bolsas propias | `examples/external-research.threesum.json` |
| 20 lecturas y 40 MB por rama | ramas delegadas | Heredan además las páginas que leyó quien delega, sin gastar |

La lista son dominios generales de literatura y documentación, no páginas elegidas: el operador no señala la solución.
Están Wikipedia (artículos de 3SUM y algoritmos), arXiv (los artículos, en HTML y en PDF), cp-algorithms (técnicas
prácticas) y la documentación de Python (lo que cuesta cada operación en el lenguaje del artefacto).

**Qué mirar después:**

- **Encontrar:** qué abrió, en qué ronda y por qué (`source_acquired` en el journal, el registro del senior y los de las
  ramas); si llegó a la literatura pertinente desde lo que ya sabía o siguiendo enlaces.
- **Entender:** si lo que dice de una fuente es lo que la fuente dice (citas `src:S…#L…`) y si distingue resultado
  teórico de rendimiento práctico.
- **Adaptar:** si traduce la técnica a Python y a este mundo (rango ±1e12, n ≤ 8000) o la copia; qué supuestos declara.
- **Validar:** si sus runs prueban lo que afirma; si, cuando la técnica no mejora la pendiente, lo dice con evidencia en
  vez de insistir.
- **Comparado con la referencia:** las mismas preguntas a `threesum-stall-A-delegation`. ¿Cambian las hipótesis, las
  direcciones de las ramas y el uso del senior?
- **Exposición:** el finding lo marca como expuesto (`external_exposure`); no cuenta como investigación sin fuentes.
