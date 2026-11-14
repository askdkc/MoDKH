import type { PluginDescriptor } from './api.ts';

/** Registration ownership is exact: an old disposer cannot remove a replacement. */
export class SubagentRegistry {
  private entries = new Map<string, Readonly<PluginDescriptor>>();
  register(descriptor: PluginDescriptor): () => void {
    if (this.entries.has(descriptor.id)) throw new Error(`Duplicate plugin: ${descriptor.id}`);
    const entry = Object.freeze({ ...descriptor });
    this.entries.set(entry.id, entry);
    return () => { if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id); };
  }
  list(): PluginDescriptor[] { return [...this.entries.values()].map(d => ({ ...d })); }
  get(id: string): Readonly<PluginDescriptor> | undefined { return this.entries.get(id); }
}
