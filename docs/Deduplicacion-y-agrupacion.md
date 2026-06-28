# Deduplicación y agrupación

Una misma persona suele estar reportada en varias plataformas. El reto: unir lo que es la misma persona **sin** fusionar por error a dos personas distintas. En un buscador de desaparecidos, una fusión equivocada **esconde** a alguien dentro del registro de otro — eso es peligroso. Por eso trabajamos en capas, de la más segura a la más conservadora.

## 1. Merge por cédula (exacto)

Si dos reportes comparten la **cédula** normalizada, son la misma persona y se fusionan. Las cédulas **V-** (venezolano) y **E-** (extranjero) nunca se confunden entre sí, aunque compartan el número.

- La cédula se normaliza (`V12345678`) tolerando puntos, guiones y espacios.
- El merge une los `SourceLink` de cada plataforma bajo una sola persona.
- Es la llave más confiable: ~70-80% de los reportes **no** traen cédula, así que las fuentes que sí la traen valen mucho más.

## 2. Sin cédula: NO se fusiona

Si un reporte no trae cédula, **no** intentamos fusionarlo entre plataformas. Se guarda como registro aparte (con dedup solo dentro de su propio silo, por `sourceId`, para no duplicar re-scrapes de la misma fuente).

¿Por qué no fusionar por nombre? Porque hay muchísimos homónimos: una búsqueda de "Oriana" devuelve Oriana Ramírez, Sivira, Correia, Ustariz… personas distintas. Fusionar por nombre las mezclaría y haría que una familia no encuentre a la suya.

## 3. Reconciliación de estado: la buena noticia gana

El estado de una persona se consolida a partir de las notas de todas sus fuentes: si **cualquiera** la reporta como `localizado`, ese es el estado que se muestra —guardando quién lo reportó y cuándo—. Un fallecido **nunca** se marca como "a salvo": las fuentes que publican fallecidos se excluyen (el modelo no representa la muerte y marcarlo así sería falso e hiriente).

## 4. Etiqueta y agrupación "posible duplicado" (capa visual)

Como sin cédula no fusionamos, una búsqueda por nombre puede devolver varias tarjetas que *parecen* la misma persona. Para que la familia no revise cinco tarjetas casi iguales, las **marcamos y agrupamos a la vista** — sin tocar el dato.

### Criterio de agrupación (`tagDuplicates` en `search.ts`)

Dos resultados se consideran "posible duplicado" si:

- comparten **≥2 tokens de nombre** (ej. `oriana` + `ustariz`), **y**
- **no** tienen ambas una cédula **distinta** (si las dos traen cédula y difieren, la cédula manda: son personas distintas).

Se agrupan por *union-find* en tiempo de búsqueda (sobre los resultados de la página, barato). Es conservador a propósito: preferimos **no** agrupar antes que agrupar de más. Ejemplos:

- "Oriana Ustariz", "ORIANA USTARIZ", "Oriana Ustariz Dinis" → **mismo grupo** (comparten oriana+ustariz).
- "Oriana Ramírez" vs "Oriana Sivira" → **no se agrupan** (solo comparten el primer nombre).
- "Oriana Ramírez V-27.606.264" vs "Ramirez Oriana V-27.006.264" → se agrupan vía un eslabón sin cédula (útil: marca un **posible typo de cédula**).

### Representante del grupo (presentación)

En el front, cada grupo se colapsa bajo una tarjeta **representante**, elegida por esta prioridad:

1. la que **tenga cédula** (más confiable),
2. la de estado **`localizado`** (la buena noticia),
3. la de **ficha más completa** (foto, edad, referencia, zona),
4. la **más reciente**.

El resto queda a un clic ("Ver N posibles duplicados"). **Nunca se oculta un registro del todo.**

> Importante: no hay "registro maestro" en el dato. La agrupación es **solo visual** y se calcula en cada búsqueda; el almacenamiento sigue teniendo cada registro por separado.

## Posible v2: IA como desempate

La IA es buena para resolución de entidades difusa (typos como *Ustariz/Uztaris*, apodos, orden de apellidos). El uso sensato sería **solo como desempate** sobre el cluster chico de cada búsqueda — nunca pairwise sobre toda la base, y **siempre** como sugerencia, no como fusión destructiva. Pendiente.
