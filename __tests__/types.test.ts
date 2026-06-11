import { describe, expect, it } from 'vitest';
import { LANGUAGES, NODE_KINDS } from '../src/types';

describe('canonical type lists', () => {
  it('keeps node kinds and languages unique', () => {
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
  });
});
