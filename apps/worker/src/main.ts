import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadWorkerEnv } from './config.js';

// Queues and job handlers arrive in Phase 5; until then the worker only serves health.
const env = loadWorkerEnv(process.env);
const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));
app.disable('x-powered-by');
app.enableShutdownHooks();
await app.listen(env.PORT, '0.0.0.0');
