// A reading unit is not a chain. Assemble introduced units through resolved dependencies,
// stopping at shared dependencies so a utility does not collect independent consumers.
export function assembleIntroducedChains(chains, usesOf, decls, isTestFile, allBlocks) {
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
    const consumers = new Set([...(blockOwners.get(block) || [])].filter((chain) => !!chain.support === isTestFile(block.file.p)));
    for (const key of uses.keys()) {
      const declaration = decls.get(key);
      // String matches and common overrides do not establish implementation ownership.
      if (declaration.str || declaration.overrides) continue;
      for (const provider of blockOwners.get(declaration.block) || []) {
        if (!!provider.support !== isTestFile(declaration.block.file.p)) continue;
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
    const users = new Map(active.map((chain) => [chain, new Set()]));
    for (const [consumer, providers] of dependencies) {
      for (const provider of providers) {
        const from = current(consumer), to = current(provider);
        if (from === to) continue;
        users.get(to).add(from);
      }
    }
    return { active, users };
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

  // Validation follows scenarios and helpers, not test chains: a same-change group can
  // contain independent scenarios, and is not a dependency between those scenarios.
  const { active } = graph();
  const supportNodes = new Map(), supportOf = new Map(), implementations = new Map();
  for (const block of allBlocks) {
    if (!isTestFile(block.file.p)) continue;
    const member = block.test || (block.member && block.member !== 'main');
    const key = block.unit || (member ? block.memberKey : block);
    if (!supportNodes.has(key)) supportNodes.set(key, { blocks: new Set(), uses: new Set(), targets: new Set() });
    const node = supportNodes.get(key);
    node.blocks.add(block);
    supportOf.set(block, node);
  }
  for (const chain of active.filter((chain) => !chain.support)) {
    for (const block of chain.blocks) {
      if (isTestFile(block.file.p)) continue;
      if (!implementations.has(block)) implementations.set(block, new Set());
      implementations.get(block).add(chain);
    }
  }
  for (const [block, uses] of usesOf) {
    const node = supportOf.get(block);
    if (!node) continue;
    for (const key of uses.keys()) {
      const declaration = decls.get(key);
      if (declaration.str || declaration.overrides) continue;
      const support = supportOf.get(declaration.block);
      if (support && support !== node) node.uses.add(support);
      for (const target of implementations.get(declaration.block) || []) node.targets.add(target);
    }
  }

  // A shared test validates each implementation independently. Include its complete
  // test context, but stop before following any implementation's own dependencies.
  const attached = new Set();
  for (const node of supportNodes.values()) {
    const context = new Set(), targets = new Set(), pending = [node];
    while (pending.length) {
      const dependency = pending.pop();
      if (context.has(dependency)) continue;
      context.add(dependency);
      pending.push(...dependency.uses);
      for (const target of dependency.targets) targets.add(target);
    }

    for (const target of targets) {
      for (const support of context) {
        for (const block of support.blocks) {
          target.blocks.add(block);
          attached.add(block);
        }
      }
    }
  }

  return active.filter((chain) => !chain.support || ![...chain.blocks].every((block) => attached.has(block)));
}
