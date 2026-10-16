// Entry point `@floty/runtime/instrument`, for the file a service loads with `node --import`.
// It must not import NestJS, pg, ioredis or anything else that tracing patches.
export * from './config.js';
export * from './telemetry.js';
