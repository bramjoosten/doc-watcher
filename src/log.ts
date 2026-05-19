type Level = 'debug' | 'info' | 'warn' | 'error';

const ENABLED: Record<Level, boolean> = (() => {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const order: Level[] = ['debug', 'info', 'warn', 'error'];
  const min = Math.max(0, order.indexOf(env as Level));
  return Object.fromEntries(order.map((l, i) => [l, i >= min])) as Record<Level, boolean>;
})();

function emit(level: Level, a: unknown, b?: unknown): void {
  if (!ENABLED[level]) return;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const ts = new Date().toISOString().slice(11, 19);
  if (typeof a === 'string') {
    stream(`${ts} ${level} ${a}`);
  } else {
    stream(`${ts} ${level} ${b ?? ''}`, a);
  }
}

export const log = {
  debug: (a: unknown, b?: unknown) => emit('debug', a, b),
  info: (a: unknown, b?: unknown) => emit('info', a, b),
  warn: (a: unknown, b?: unknown) => emit('warn', a, b),
  error: (a: unknown, b?: unknown) => emit('error', a, b),
};
