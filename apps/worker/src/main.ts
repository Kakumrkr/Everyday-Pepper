import 'reflect-metadata';
import { createServiceApp } from '@floty/runtime';
import { AppModule } from './app.module.js';
import { loadWorkerConfig } from './config.js';

// Queues and job handlers arrive in Phase 5; until then the worker only serves health.
const config = loadWorkerConfig(process.env);
const app = await createServiceApp(AppModule.forRoot(config), config);
await app.listen(config.port, '0.0.0.0');
