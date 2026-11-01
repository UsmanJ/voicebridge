// Runs the example host token route. DEMO ONLY.
// Usage (from examples/host-token-route): pnpm start
import { createServer } from 'node:http';
import { loadHostConfig } from './config.ts';
import { createHostApp } from './host.ts';

let config;
try {
  config = loadHostConfig(process.env);
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      src: 'host',
      message: error instanceof Error ? error.message : 'invalid configuration',
    }),
  );
  process.exit(1);
}

const { handler } = createHostApp({
  ...config.app,
  logger: (event, fields = {}) => console.log(JSON.stringify({ src: 'host', event, ...fields })),
});

createServer((req, res) => void handler(req, res)).listen(config.port, config.bindHost, () => {
  if (process.env.VB_DEV_AUTH === 'localhost') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        src: 'host',
        message:
          'DEVELOPMENT AUTHENTICATION ENABLED: every local request is the synthetic user. Never expose this port through a proxy, tunnel, or container port mapping.',
      }),
    );
  }
  console.log(
    JSON.stringify({
      src: 'host',
      event: 'listening',
      host: config.bindHost,
      port: config.port,
      applicationId: config.app.applicationId,
      devAuth: process.env.VB_DEV_AUTH === 'localhost',
      allowedOrigins: config.app.allowedOrigins.length,
    }),
  );
});
