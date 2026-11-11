/**
 * Tiny local HTTP sink used while capturing reference renders from a Figma
 * browser tab: the page POSTs PNG bytes (and JSON manifests) here and they are
 * written under the output directory.
 *
 *   node tools/figma-refs/receiver.ts <outDir> [port]
 *
 *   POST /put?path=<relative/path.png>          body = raw bytes
 *   GET  /put?path=<relative/path>&text=<text>  for pages whose CSP forbids fetch() to localhost
 *                                               (navigate the tab here instead)
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const outDir = resolve(process.argv[2] ?? 'tools/visual/.work/refs');
const port = Number(process.argv[3] ?? 8791);

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const inlineText = url.searchParams.get('text');
  if (req.method === 'GET' && url.pathname === '/put' && inlineText !== null) {
    const target = resolve(outDir, url.searchParams.get('path') ?? '');
    if (!target.startsWith(outDir + sep)) {
      res.writeHead(400).end('bad path');
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, inlineText);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('saved');
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/put') {
    res.writeHead(404).end('not found');
    return;
  }
  const target = resolve(outDir, url.searchParams.get('path') ?? '');
  if (!target.startsWith(outDir + sep)) {
    res.writeHead(400).end('bad path');
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    mkdirSync(dirname(target), { recursive: true });
    const body = Buffer.concat(chunks);
    writeFileSync(target, body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytes: body.length }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`receiver writing to ${outDir} on http://127.0.0.1:${port}`);
});
