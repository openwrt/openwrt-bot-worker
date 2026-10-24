import { test, describe } from 'node:test';
import assert from 'node:assert';
import { cpuRatio } from './helpers.js';

// cpuRatio on a thread clock like Linux's, which advances in scheduler ticks.
// The clock and the arms share a virtual count of milliseconds, so what each
// arm costs is exact and the result is the same on every machine: each read
// of the clock costs 1 µs, and the clock shows only whole ticks of 4 ms, as
// on a kernel built with HZ=250.
describe('cpuRatio on a clock of 4 ms ticks', () => {
  const clock = () => {
    globalThis.virtualMs = (globalThis.virtualMs ?? 0) + 0.001;
    return Math.floor(globalThis.virtualMs / 4) * 4;
  };

  test('times rounds long enough that a cold first call does not leave them at no ticks', async () => {
    // The base arm's first two calls cost 50 ms, as a cold one can, which
    // used to end the calibration at one repetition: rounds far shorter than
    // a tick, reading 0 and dividing by it.
    const { ratio, ratios, measuredMs, tickMs, roundMs } = await cpuRatio(({ data: { cost } }) => {
      let calls = 0;
      const spend = (ms) => { globalThis.virtualMs = (globalThis.virtualMs ?? 0) + ms; };
      return { base: () => spend(++calls <= 2 ? 50 : cost), measured: () => spend(3 * cost) };
    }, { cost: 0.3 }, { what: 'a virtual arm', clock });
    assert.deepStrictEqual([tickMs, roundMs], [4, 40]);
    assert.ok(ratios.every(r => r > 2.5 && r < 3.6), `rounds of a 3x arm read ${ratios.join(', ')}`);
    assert.ok(Math.abs(ratio - 3) < 0.3, `a 3x arm read as ${ratio}x`);
    assert.ok(Math.abs(measuredMs - 0.9) < 0.1, `a 0.9 ms call read as ${measuredMs} ms`);
  });

  test('does not read a measured arm far cheaper than a tick as free', async () => {
    const { ratio, ratios, measuredMs } = await cpuRatio(({ data: { cost } }) => {
      const spend = (ms) => { globalThis.virtualMs = (globalThis.virtualMs ?? 0) + ms; };
      return { base: () => spend(cost), measured: () => spend(cost / 20) };
    }, { cost: 0.4 }, { what: 'a virtual arm', clock });
    assert.ok(ratios.every(r => r > 0.035 && r < 0.065), `rounds of a twentieth-cost arm read ${ratios.join(', ')}`);
    assert.ok(Math.abs(ratio - 0.05) < 0.005, `a twentieth-cost arm read as ${ratio}x`);
    assert.ok(measuredMs > 0.018 && measuredMs < 0.022, `a 0.02 ms call read as ${measuredMs} ms`);
  });
});
