import { describe, expect, it } from 'vitest';
import { createTaskErrorMessage } from './NewTaskPage';

describe('createTaskErrorMessage', () => {
  it('traduit le fallback de création', () => {
    expect(createTaskErrorMessage({})).toBe('Impossible de créer la mission');
  });
});
