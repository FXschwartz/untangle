// A reading unit is not a chain. Assemble introduced units through resolved dependencies,
// stopping at shared dependencies so a utility does not collect independent consumers.
export function assembleIntroducedChains(chains, usesOf, decls) {
  const owner = new Map(chains.map((chain) => [chain, chain]));
  const current = (chain) => {
    while (owner.get(chain) !== chain) {
      owner.set(chain, owner.get(owner.get(chain)));
      chain = owner.get(chain);
    }
    return chain;
  };
  const blockOwners = new Map();
  for (const chain of chains) {
    for (const block of chain.blocks) {
      if (!blockOwners.has(block)) blockOwners.set(block, new Set());
      blockOwners.get(block).add(chain);
    }
  }

  const dependencies = new Map(chains.map((chain) => [chain, new Set()]));
  const unownedUsers = new Set();
  for (const [block, uses] of usesOf) {
    const consumers = blockOwners.get(block);
    for (const key of uses.keys()) {
      const declaration = decls.get(key);
      // String matches and common overrides do not establish implementation ownership.
      if (declaration.str || declaration.overrides) continue;
      for (const provider of blockOwners.get(declaration.block) || []) {
        if (!consumers?.size) unownedUsers.add(provider);
        for (const consumer of consumers || []) {
          if (consumer !== provider) dependencies.get(consumer).add(provider);
        }
      }
    }
  }

  const merge = (part, whole) => {
    part = current(part);
    whole = current(whole);
    if (part === whole) return;

    for (const block of part.blocks) whole.blocks.add(block);
    owner.set(part, whole);
  };
  const graph = () => {
    const active = chains.filter((chain) => current(chain) === chain);
    const uses = new Map(active.map((chain) => [chain, new Set()]));
    const users = new Map(active.map((chain) => [chain, new Set()]));
    for (const [consumer, providers] of dependencies) {
      for (const provider of providers) {
        const from = current(consumer), to = current(provider);
        if (from === to) continue;
        uses.get(from).add(to);
        users.get(to).add(from);
      }
    }
    return { active, uses, users };
  };

  // Mutually dependent new declarations belong together. Condensing cycles first makes
  // exclusive ownership independent of declaration order, including recursive helpers.
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set();
  const visit = (chain) => {
    indices.set(chain, index);
    low.set(chain, index++);
    stack.push(chain);
    onStack.add(chain);
    for (const next of dependencies.get(chain)) {
      if (next.kind !== 'declaration' || next.support !== chain.support) continue;
      if (!indices.has(next)) {
        visit(next);
        low.set(chain, Math.min(low.get(chain), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(chain, Math.min(low.get(chain), indices.get(next)));
      }
    }
    if (low.get(chain) !== indices.get(chain)) return;

    const component = [];
    let next;
    do {
      next = stack.pop();
      onStack.delete(next);
      component.push(next);
    } while (next !== chain);

    // Name a cycle for its public entry point, rather than whichever helper was visited
    // first. External production consumers identify that entry point without name rules.
    const consumers = (candidate) => [...dependencies].filter(([user, providers]) =>
      !component.includes(user) && !user.support && providers.has(candidate)).length;
    const privateName = (candidate) => candidate.name.split(/[.,]\s*/).some((name) => name.startsWith('_'));
    component.sort((a, b) => Number(privateName(a)) - Number(privateName(b)) || consumers(b) - consumers(a)
      || (a.root.file < b.root.file ? -1 : a.root.file > b.root.file ? 1 : a.root.line - b.root.line));
    for (const part of component) merge(part, component[0]);
  };
  for (const chain of chains) {
    if (chain.kind === 'declaration' && !indices.has(chain)) visit(chain);
  }

  // Tests do not become owners of production APIs, and shared fixtures do not combine
  // test scenarios. Only a sole consumer in the same role establishes ownership.
  let changed = true;
  while (changed) {
    changed = false;
    const { active, users } = graph();
    const blocked = new Set([...unownedUsers].map(current));
    for (const chain of active) {
      if (current(chain) !== chain || chain.kind !== 'declaration' || blocked.has(chain)) continue;
      const consumers = new Set([...users.get(chain)].map(current).filter((consumer) => consumer !== chain && !!consumer.support === !!chain.support));
      if (consumers.size !== 1) continue;
      merge(chain, [...consumers][0]);
      changed = true;
      break;
    }
  }

  // A complete new scenario can follow a changed existing behavior. For entirely new
  // code, require an exclusive relationship in both directions: many tests using a new
  // fixture or API do not make one change-propagation chain.
  const { active, uses, users } = graph();
  for (const chain of active) {
    if (chain.kind !== 'declaration' || !chain.support) continue;
    if (![...chain.blocks].some((block) => block.unit?.kind === 'test')) continue;
    const targets = new Set([...uses.get(chain)].map(current).filter((target) => !target.support));
    if (targets.size !== 1) continue;
    const target = [...targets][0];
    if (target.kind === 'declaration' && [...users.get(target)].filter((user) => user.support).length !== 1) continue;
    merge(chain, target);
  }

  return chains.filter((chain) => current(chain) === chain);
}
