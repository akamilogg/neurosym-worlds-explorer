/* The providers' proxy (SPEC-METAPOLITICA-APRENDIZAJE §12, §13), on the OPERATOR's machine - never the junior's. It holds
   the providers' keys in its own environment (each upstream's key_env), pays every call from a bag, and keeps its ledger:

     node --experimental-strip-types scripts/provider-proxy.ts --config <proxy.json> [--host <address>] [--port 18800]

   The config (see lib/examples/junior.proxy.example.json) names clients by the SHA-256 of their token, never the token:
     node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>
   On the junior's machine: LLM_URL=http://<host>:<port>/<upstream>/v1/chat/completions and LLM_KEY=<token>.
   --host is the one address the junior's machine reaches it by; it is 127.0.0.1 by default. Ctrl+C stops it. */
import fs from 'node:fs';
import { ProviderProxy, serveProxy } from '../src/junior/proxy.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const config = arg('config');
if (!config) { console.error('provider-proxy --config <proxy.json> [--host <address>] [--port 18800]'); process.exit(2); }
const proxy = new ProviderProxy(JSON.parse(fs.readFileSync(config, 'utf8')));
const s = await serveProxy(proxy, { port: Number(arg('port', '18800')), host: arg('host', '127.0.0.1') });
console.log('providers\' proxy on ' + s.url + '; bags: ' + Object.entries(proxy.status()).map(([n, b]) => n + ' ' + b.spent.tokens + '/' + b.limit.tokens + ' tokens').join(', '));
process.on('SIGINT', () => { void s.close().then(() => process.exit(0)); });
