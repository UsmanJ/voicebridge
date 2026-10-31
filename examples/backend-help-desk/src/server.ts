// Runs the example help-desk backend. DEMO ONLY (in-memory sessions).
// Usage (from examples/backend-help-desk): pnpm start
import { createServer } from 'node:http';
import { createHelpDeskBackend } from './backend.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      JSON.stringify({
        level: 'error',
        src: 'help-desk',
        message: `missing environment variable ${name}`,
      }),
    );
    process.exit(1);
  }
  return value;
}

const host = process.env.HELP_DESK_BIND ?? '127.0.0.1';
const port = Number(process.env.HELP_DESK_PORT ?? 8788);
const applicationId = process.env.VB_APPLICATION_ID ?? 'help-desk';

const { handler } = createHelpDeskBackend({
  applications: [
    {
      applicationId,
      workerCredential: required('HELP_DESK_WORKER_CREDENTIAL'),
      hostCredential: required('HELP_DESK_HOST_CREDENTIAL'),
    },
  ],
  logger: (event, fields = {}) =>
    console.log(JSON.stringify({ src: 'help-desk', event, ...fields })),
});

createServer((req, res) => void handler(req, res)).listen(port, host, () => {
  console.log(
    JSON.stringify({
      src: 'help-desk',
      event: 'listening',
      host,
      port,
      applicationId,
      storage: 'in-memory (demo only)',
    }),
  );
});
