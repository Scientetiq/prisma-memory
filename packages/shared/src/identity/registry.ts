import type { ProviderDescriptor } from "./ports.ts";

/** Explicit process-local wiring only: no credentials, settings snapshots, identity cache or authorization decisions. */
export class ProviderRegistry<P extends ProviderDescriptor, A extends { readonly mode: string } = never> {
  private readonly providers = new Map<string, P>();
  private readonly agents = new Map<string, A>();
  constructor(providers: readonly P[], agents: readonly A[] = []) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate identity provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
    for (const agent of agents) {
      if (this.agents.has(agent.mode)) throw new Error(`Duplicate agent auth mode: ${agent.mode}`);
      this.agents.set(agent.mode, agent);
    }
  }
  get<K extends P["id"]>(id: K): Extract<P, { readonly id: K }> | (string extends P["id"] ? P : never);
  get(id: string): P;
  get(id: string): P {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown identity provider: ${id}`);
    return provider;
  }
  list(): P[] { return [...this.providers.values()]; }
  agent(mode: string): A {
    const agent = this.agents.get(mode);
    if (!agent) throw new Error(`Unknown agent auth mode: ${mode}`);
    return agent;
  }
}
