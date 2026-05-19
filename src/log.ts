import { pino } from 'pino';

const isTTY = Boolean(process.stdout.isTTY);

export const log = pino(
  isTTY
    ? {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level: process.env.LOG_LEVEL ?? 'info' },
);
