import 'reflect-metadata';
import { createServiceApp } from '@pepper/runtime';
import { AppModule } from './app.module.js';
import { loadWorkerConfig } from './config.js';

// Serves health over HTTP and runs the outbox relay and delivery (ADR-0024).
const config = loadWorkerConfig(process.env);
const app = await createServiceApp(AppModule.forRoot(config), config);
await app.listen(config.port, '0.0.0.0');
