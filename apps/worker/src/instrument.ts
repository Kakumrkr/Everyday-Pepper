// Loaded with `node --import ./dist/instrument.js` so tracing can patch modules as main.ts
// imports them. Import nothing here that tracing patches (NestJS, pg, ioredis).
import { startObservability } from '@floty/runtime/instrument';
import { loadWorkerConfig } from './config.js';

startObservability(loadWorkerConfig(process.env));
