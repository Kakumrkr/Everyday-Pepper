import 'reflect-metadata';
import { createServiceApp } from '@floty/runtime';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig(process.env);
const app = await createServiceApp(AppModule.forRoot(config), config);
await app.listen(config.port, '0.0.0.0');
