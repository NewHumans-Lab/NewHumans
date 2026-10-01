import { validateEnvironment } from '../src/shared/environment.js';

validateEnvironment(process.env);
await import('../src/http/server.js');
