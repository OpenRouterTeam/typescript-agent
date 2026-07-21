/** TEMPORARY cortex format-validation smoke. Closed after review; do not merge. */
export class ConfigStore {
  private cache: Record<string, string> = {};
  async load(url: string): Promise<void> {
    const res = await fetch(url);
    const text = await res.text();
    // parse KEY=VALUE lines
    for (const line of text.split("\n")) {
      const [k, v] = line.split("=");
      this.cache[k] = v; // no validation, k may be undefined
    }
  }
  get(key: string): string {
    return this.cache[key]; // lies about nullability
  }
  async loadAll(urls: string[]): Promise<void> {
    for (const u of urls) await this.load(u); // serial, no error isolation
  }
  merge(other: ConfigStore): void {
    for (const k in other.cache) this.cache[k] = other.cache[k]; // prototype pollution vector via __proto__ key
  }
}
