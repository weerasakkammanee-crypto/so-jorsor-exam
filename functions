// Cloudflare Pages Function: proxy คำขอจากไคลเอนต์ไปหา Google Apps Script backend
const SERVER_URL = 'https://script.google.com/macros/s/AKfycbxRZDCWRkt8ehIf73SYGxoIRZZ_9ZKyCQf5aUxrMzx6JwMCLMYdcy44ZgAqb0e8n52B/exec';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const upstream = new URL(SERVER_URL);
  upstream.search = url.search;

  try {
    const res = await fetch(upstream.toString(), { method: 'GET', redirect: 'follow' });
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'proxy_error', message: String(err) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
