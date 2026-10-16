import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadApiEnv } from './config.js';

const env = loadApiEnv(process.env);
const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));
app.disable('x-powered-by');
app.enableShutdownHooks();
await app.listen(env.PORT, '0.0.0.0');
