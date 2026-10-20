import { describe, expect, it } from 'vitest';
import { taskDuePush } from './task-pushes.js';

const ID = '0199f4b2-7c1e-7a00-8000-000000000001';

describe('taskDuePush (ADR-0026)', () => {
  it('names a due to-do by its title, opening Home', () => {
    expect(taskDuePush('Order color', ID)).toEqual({
      title: 'To-do due',
      body: 'Order color',
      url: '/',
      tag: `task-${ID}`,
    });
    expect(taskDuePush('x'.repeat(250), ID).body).toHaveLength(200);
  });
});
