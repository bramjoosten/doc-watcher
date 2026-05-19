// Minimal bounded-concurrency helper. Same shape as p-limit's default export —
// wraps a Promise-returning task so at most `n` are running at any moment.
// Inlined to avoid a dep for ~15 lines of logic.

export type LimitFunction = <T>(task: () => Promise<T>) => Promise<T>;

export function pLimit(n: number): LimitFunction {
  let running = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (running >= n) return;
    const job = queue.shift();
    if (!job) return;
    running++;
    job();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
}
