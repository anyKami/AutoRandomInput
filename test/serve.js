import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url, 'http://127.0.0.1');
        const pathname = decodeURIComponent(requestUrl.pathname);
        if (pathname === '/') {
            response.writeHead(302, { Location: '/test/preview.html' }); response.end(); return;
        }
        if (pathname === '/mobile') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            requestUrl.searchParams.set('embed', '1');
            response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>AutoRandomInput · 手机预览</title><body style="margin:0;background:#293446;display:grid;place-items:center;min-height:100vh"><iframe title="手机宽度预览" src="/test/preview.html?${requestUrl.searchParams}" style="width:390px;height:844px;max-height:100vh;border:0"></iframe></body></html>`);
            return;
        }
        const target = path.resolve(root, '.' + pathname);
        if (!target.startsWith(root + path.sep) || !types[path.extname(target)]) {
            response.writeHead(404); response.end(); return;
        }
        const content = await readFile(target);
        response.writeHead(200, { 'Content-Type': `${types[path.extname(target)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(content);
    } catch {
        response.writeHead(404); response.end('Not found');
    }
}).listen(18743, '127.0.0.1', () => console.log('AutoRandomInput preview: http://127.0.0.1:18743'));
