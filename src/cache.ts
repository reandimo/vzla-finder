/**
 * Cache de resultados del buscador (en memoria, con TTL).
 *
 * La data cambia despacio frente al volumen de consultas de las familias, así
 * que cachear las respuestas unos segundos absorbe los picos de tráfico sin
 * pegarle a SQLite en cada tecla. Para un front con Cloudflare adelante, esto
 * es la segunda línea (origin cache); el edge es la primera.
 *
 * Es un Map con expiración + tope de tamaño (descarta lo más viejo). Para
 * varias instancias, cambiá esta clase por Redis con la misma interfaz.
 */
export class QueryCache<T> {
  private map = new Map<string, { value: T; expires: number }>();

  constructor(
    private ttlMs = 30_000,
    private maxEntries = 5000,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  /** Envuelve una función de búsqueda con cache. */
  wrap(key: string, fn: () => T): T {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = fn();
    this.set(key, value);
    return value;
  }

  clear() {
    this.map.clear();
  }
}
