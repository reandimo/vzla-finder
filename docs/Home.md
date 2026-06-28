# vzla-finder — Wiki

Un solo buscador para encontrar a los desaparecidos del terremoto de Venezuela (2026). Reúne los reportes de varias plataformas ciudadanas en una sola búsqueda y, si alguien ya fue reportado a salvo en cualquiera de ellas, lo muestra al instante.

🔎 **En vivo:** [busquedaunificadavzla.com](https://busquedaunificadavzla.com)

## Páginas

- **[Arquitectura](Arquitectura.md)** — el flujo completo: ingesta → deduplicación → reconciliación → búsqueda, y los módulos del código.
- **[Deduplicación y agrupación](Deduplicacion-y-agrupacion.md)** — cómo unimos (cédula), por qué *no* fusionamos sin cédula, y la etiqueta/agrupación de "posible duplicado".
- **[Fuentes](Fuentes.md)** — qué plataformas consultamos, criterio para sumar una, y cómo escribir un adaptador.
- **[API pública](API-publica.md)** — el feed PFIF 1.4 de federación y los endpoints de búsqueda, con la política de datos personales.

## Principios que no se negocian

- **Buen ciudadano de la web:** pull espaciado, cacheado y con requests condicionales. Una fuente caída nunca frena a las demás.
- **Re-hostear lo mínimo:** para el contacto, se enlaza a la ficha original.
- **Nunca afirmar una coincidencia sin cédula:** se sugiere, no se decide. En un buscador de desaparecidos, fusionar mal puede esconder a una persona.
- **Sin PII en lo público:** el feed de federación no incluye cédula ni datos de contacto.
- **Proyecto altruista, sin fines de lucro.** Solo reunimos lo que las plataformas ciudadanas ya publican.

🚨 ¿Emergencia en Venezuela? Llama al **171** (gestión de riesgos / Protección Civil).
