// Side-effect module: disable TLS certificate verification process-wide and
// silence the warning Node would otherwise print on every HTTPS connection.
//
// This is a deliberate trade-off for doc-watcher: the typical deployment is a
// single-user CLI talking to an internal corporate Confluence whose certificate
// chain is signed by a private CA that Node doesn't trust by default. The
// "correct" fix is `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`, but that puts a
// pem-wrangling task on every user. Since the surface is just "fetch pages
// over a network you already trust," skipping cert verification is acceptable.
//
// Import this *first* from the entry point so the override is in place before
// any HTTPS request fires.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const originalEmitWarning = process.emitWarning.bind(process);
(process as { emitWarning: (...args: unknown[]) => void }).emitWarning = (
  warning: unknown,
  ...rest: unknown[]
): void => {
  const text = warning instanceof Error ? warning.message : String(warning);
  if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
};
