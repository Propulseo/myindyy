import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextRing } from '../client/src/components/InputToolbar.tsx';

function renderPercentage(usedTokens: number, windowTokens: number): string {
  return renderToStaticMarkup(createElement(ContextRing, {
    context: {
      used_tokens: usedTokens,
      window_tokens: windowTokens,
    },
  }));
}

describe('ContextRing', () => {
  it('renders a bounded rounded context percentage', () => {
    expect(renderPercentage(14, 100)).toMatch(/>14%<\/span>/);
    expect(renderPercentage(1, 3)).toMatch(/>33%<\/span>/);
    expect(renderPercentage(0, 0)).toMatch(/>0%<\/span>/);
    expect(renderPercentage(100, 100)).toMatch(/>100%<\/span>/);
    expect(renderPercentage(200, 100)).toMatch(/>100%<\/span>/);
    expect(renderPercentage(200, 100)).toMatch(/title="Context: 200% used"/);
  });
});
