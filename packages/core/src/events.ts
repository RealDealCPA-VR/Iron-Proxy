import type { IronEvent, IronEventType } from './types.js';

export type Listener<E> = (event: E) => void;

/**
 * Tiny typed emitter. Listeners never throw into the emitter: a listener error
 * is reported through `onListenerError` and the rest still run.
 */
export class TypedEmitter<E extends { type: string }> {
  private readonly listeners = new Map<string, Set<Listener<E>>>();
  private readonly anyListeners = new Set<Listener<E>>();
  onListenerError: (err: unknown, event: E) => void = () => {};

  on<T extends E['type']>(type: T, listener: Listener<Extract<E, { type: T }>>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<E>);
    return () => this.off(type, listener);
  }

  off<T extends E['type']>(type: T, listener: Listener<Extract<E, { type: T }>>): void {
    this.listeners.get(type)?.delete(listener as Listener<E>);
  }

  onAny(listener: Listener<E>): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  emit(event: E): void {
    const targets = [...(this.listeners.get(event.type) ?? []), ...this.anyListeners];
    for (const l of targets) {
      try {
        l(event);
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}

export type IronEmitter = TypedEmitter<IronEvent>;
export type { IronEvent, IronEventType };
