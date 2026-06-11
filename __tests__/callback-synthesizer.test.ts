import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * Direct regression coverage for the core synthesizeCallbackEdges channels.
 * Each channel gets a minimal fixture; assertions pin the exact edge
 * (source → target), its provenance/synthesizedBy metadata, and the wiring
 * site. A full re-index at the end pins the two invariants every synthesizer
 * change must hold: no node explosion (node count stable) and no edge
 * duplication (delete-then-reinsert keeps heuristic edges idempotent).
 *
 * Channels covered, mirroring the validated excalidraw flow shapes:
 *  - 'callback'      field-backed observer (onUpdate registers → triggerUpdate dispatches)
 *  - 'event-emitter' string-keyed channel (emit('saved') ↔ on('saved', handler))
 *  - 'react-render'  this.setState(...) → sibling render()
 *  - 'jsx-render'    render() → <Child /> component
 */
describe('callback synthesizer channels', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callback-synth-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes the four core channels with correct metadata and stays idempotent on re-index', async () => {
    // 'callback': registrar + dispatcher share the `callbacks` field in one
    // file; the wiring site (scene.onUpdate(this.triggerRender)) lives in another.
    fs.writeFileSync(
      path.join(dir, 'scene.ts'),
      `export class Scene {
  private callbacks = new Set<() => void>();

  onUpdate(cb: () => void) {
    this.callbacks.add(cb);
  }

  triggerUpdate() {
    this.callbacks.forEach((cb) => cb());
  }
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'app.ts'),
      `import { Scene } from './scene';

export class App {
  scene = new Scene();

  triggerRender() {
    return 'render';
  }

  mount() {
    this.scene.onUpdate(this.triggerRender);
  }
}
`
    );

    // 'event-emitter': emit and on share the string key 'saved'.
    fs.writeFileSync(
      path.join(dir, 'bus.ts'),
      `import { EventEmitter } from 'node:events';

const bus = new EventEmitter();

export function handleSaved() {
  return 'saved';
}

export function wireBus() {
  bus.on('saved', handleSaved);
}

export function fireSaved() {
  bus.emit('saved');
}
`
    );

    // 'react-render' (bump → render via setState) + 'jsx-render' (render → Canvas).
    fs.writeFileSync(
      path.join(dir, 'Counter.tsx'),
      `import { Canvas } from './Canvas';

export class Counter {
  bump() {
    this.setState({ count: 1 });
  }

  render() {
    return <Canvas />;
  }
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'Canvas.tsx'),
      `export function Canvas() {
  return <div />;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const heuristicEdges = () =>
      db
        .prepare(
          `SELECT json_extract(e.metadata,'$.synthesizedBy') synth,
                  s.name source_name, t.name target_name,
                  e.kind, e.provenance,
                  json_extract(e.metadata,'$.registeredAt') registeredAt
           FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
           WHERE e.provenance = 'heuristic'
           ORDER BY synth, source_name, target_name`
        )
        .all() as Array<{
        synth: string;
        source_name: string;
        target_name: string;
        kind: string;
        provenance: string;
        registeredAt: string | null;
      }>;
    const nodeCount = () =>
      (db.prepare('SELECT count(*) c FROM nodes').get() as { c: number }).c;

    const rows = heuristicEdges();
    const nodesAfterFirstIndex = nodeCount();

    // Every synthesized edge is a heuristic `calls` hop.
    expect(rows.every((r) => r.kind === 'calls')).toBe(true);

    // 'callback': dispatcher → registered callback, wiring site surfaced.
    const cb = rows.filter((r) => r.synth === 'callback');
    expect(cb).toHaveLength(1);
    expect(cb[0]!.source_name).toBe('triggerUpdate');
    expect(cb[0]!.target_name).toBe('triggerRender');
    expect(cb[0]!.registeredAt).toMatch(/app\.ts:\d+$/);

    // 'event-emitter': emitter → handler, keyed by the registration site.
    const ee = rows.filter((r) => r.synth === 'event-emitter');
    expect(ee).toHaveLength(1);
    expect(ee[0]!.source_name).toBe('fireSaved');
    expect(ee[0]!.target_name).toBe('handleSaved');
    expect(ee[0]!.registeredAt).toMatch(/bus\.ts:\d+$/);

    // 'react-render': setState caller → sibling render.
    const rr = rows.filter((r) => r.synth === 'react-render');
    expect(rr).toHaveLength(1);
    expect(rr[0]!.source_name).toBe('bump');
    expect(rr[0]!.target_name).toBe('render');

    // 'jsx-render': render → child component (lowercase <div /> is ignored).
    const jsx = rows.filter((r) => r.synth === 'jsx-render');
    expect(jsx.length).toBeGreaterThanOrEqual(1);
    expect(jsx.some((r) => r.target_name === 'Canvas')).toBe(true);
    expect(jsx.some((r) => r.target_name === 'div')).toBe(false);

    // No node explosion + idempotence: a full re-index must keep the node
    // count stable and reproduce the exact same heuristic edge set (the
    // synthesizers delete-then-reinsert, so duplicates mean a regression).
    await cg.indexAll();
    expect(nodeCount()).toBe(nodesAfterFirstIndex);
    expect(heuristicEdges()).toEqual(rows);

    cg.close?.();
  }, 60000);
});
