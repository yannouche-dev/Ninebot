// localStorage minimal pour Node (le coffre l'utilise dans le navigateur).
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
export function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  return s;
}
