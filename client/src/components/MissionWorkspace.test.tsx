// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MissionWorkspace } from './MissionWorkspace';
import { AppMain } from './AppMain';

afterEach(cleanup);

it('garde le workspace et les contrôles scrollables sur mobile', () => {
  render(
    <AppMain>
      <MissionWorkspace chat={<div>Conversation</div>} execution={<button>Arrêter</button>} />
    </AppMain>,
  );

  expect(screen.getByRole('main')).toHaveClass('min-h-0', 'overflow-y-auto', 'sm:overflow-hidden');
  expect(screen.getByTestId('mission-workspace')).toHaveClass('min-h-0', 'overflow-y-auto');
  expect(screen.getByRole('complementary', { name: 'Exécution de la mission' })).toHaveClass('min-h-0', 'lg:overflow-y-auto');
  expect(screen.getByRole('button', { name: 'Arrêter' })).toBeVisible();
});
