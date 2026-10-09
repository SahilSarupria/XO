/**
 * Performance benchmarks for atlas's hot paths.
 *
 * These are not correctness tests (see tests/) — they exist so a
 * change to the engine's internals can be checked against a rough
 * budget before it ships. Run with `npm run bench` (or `pnpm bench`).
 */
import { Camera } from '../src/camera.js';
import { NeighborhoodEngine } from '../src/neighborhoods.js';
import { SemanticZoomRegistry } from '../src/semantic-zoom.js';
function bench(name, iterations, fn) {
    // warm up the JIT before measuring
    for (let i = 0; i < Math.min(1000, iterations); i++)
        fn();
    const start = performance.now();
    for (let i = 0; i < iterations; i++)
        fn();
    const elapsedMs = performance.now() - start;
    const perOpUs = (elapsedMs / iterations) * 1000;
    console.log(`${name.padEnd(42)} ${iterations.toString().padStart(8)} ops  ${elapsedMs.toFixed(2).padStart(10)} ms total  ${perOpUs.toFixed(3).padStart(10)} µs/op`);
}
console.log('atlas — performance benchmarks\n' + '='.repeat(70));
// -- Camera.tick() under steady load, the thing that runs every frame ----
{
    const camera = new Camera();
    camera.flyTo({ x: 500, y: 500 }, { altitude: 4 });
    bench('Camera.tick() (60fps step, warm spring)', 200_000, () => {
        camera.tick(1 / 60);
    });
}
// -- issuing a fresh movement command each call ---------------------------
{
    const camera = new Camera();
    let i = 0;
    bench('Camera.flyTo() (new target each call)', 100_000, () => {
        i += 1;
        camera.flyTo({ x: i % 1000, y: (i * 7) % 1000 });
    });
}
// -- semantic zoom evaluated across many registered rules -----------------
{
    const registry = new SemanticZoomRegistry();
    for (let i = 0; i < 500; i++) {
        registry.register({ id: `rule_${i}`, appearsAt: i % 8, fullyVisibleAt: (i % 8) + 1 });
    }
    bench('SemanticZoomRegistry.visible() (500 rules)', 20_000, () => {
        registry.visible(3.5);
    });
}
// -- neighborhood queries at realistic ecosystem scale ---------------------
{
    const engine = new NeighborhoodEngine();
    const N = 2000;
    for (let i = 0; i < N; i++) {
        engine.place(`entity_${i}`, { x: (i * 37) % 1000, y: (i * 91) % 1000 });
    }
    bench(`NeighborhoodEngine.neighborsOf() (${N} entities, k=10)`, 2_000, () => {
        engine.neighborsOf('entity_0', 10);
    });
    bench(`NeighborhoodEngine.clusterByProximity() (${N} entities)`, 20, () => {
        engine.clusterByProximity(15);
    });
}
console.log('='.repeat(70));
console.log('Done. These numbers are a budget, not a promise — re-run on the');
console.log('target hardware before treating a regression as confirmed.');
//# sourceMappingURL=bench.js.map