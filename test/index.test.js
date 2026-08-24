import assert from 'node:assert/strict';
import test from 'node:test';
import { indexInternals } from '../src/index.js';

test('a failed item is recovered without stopping later work', async () => {
  const visited = [];
  const results = await indexInternals.runWithConcurrency(
    ['first', 'fails', 'last'],
    2,
    async (item) => {
      visited.push(item);
      if (item === 'fails') throw new Error('intentional test failure');
      return item.toUpperCase();
    },
    (error, item) => `${item}: ${error.message}`,
  );

  assert.deepEqual(results, ['FIRST', 'fails: intentional test failure', 'LAST']);
  assert.equal(visited.includes('last'), true);
});
