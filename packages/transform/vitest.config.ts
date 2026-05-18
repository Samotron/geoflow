import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'transform',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
