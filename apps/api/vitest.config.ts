import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild cannot emit decorator metadata, which Nest's dependency injection reads; SWC can.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // TenancyService, TeamService, InvitesService, AppointmentsService, BookingsService and
      // ClientsService only bind the database to @pepper/db repositories and domain services;
      // like them they are proven against real Postgres by the integration tests
      // (src/**/*.int.test.ts), not by unit tests.
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/instrument.ts',
        'src/account/tenancy.service.ts',
        'src/team/invites.service.ts',
        'src/team/team.service.ts',
        'src/appointments/appointments.service.ts',
        'src/appointments/bookings.service.ts',
        'src/clients/clients.service.ts',
        // Chat runs the agent loop on Postgres and keeps events in Redis: chat.int.test.ts.
        'src/chat/chat.service.ts',
        'src/chat/turn-events.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
