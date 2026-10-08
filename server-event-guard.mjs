// Each API connection owns its own cache. Only a repeated server event ID is
// a duplicate: equal audio, words or timestamps may be genuine repeated speech.
export class ServerEventGuard {
  #seen = new Set();
  #capacity;

  constructor(capacity = 20000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid server event cache capacity');
    this.#capacity = capacity;
  }

  accept(event) {
    const id = event?.event_id;
    // Preserve events without IDs, including older test/transport adapters.
    if (typeof id !== 'string' || !id.length) return true;
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    // Bound memory for long conferences, retaining the most recent unique IDs.
    if (this.#seen.size > this.#capacity) this.#seen.delete(this.#seen.values().next().value);
    return true;
  }

  get size() { return this.#seen.size; }
  clear() { this.#seen.clear(); }
}
