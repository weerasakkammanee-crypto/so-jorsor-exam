// Cloudflare Worker (standalone, ไม่ต้องใช้ Pages/GitHub): LINE Official Account chatbot webhook
// จุดประสงค์ V1: รับข้อความจากลูกค้าที่ทักแชท LINE OA เพื่อ "ขายสิทธิ์เข้าใช้แอปข้อสอบ"
//   - ลูกค้าพิมพ์ username ที่ต้องการ -> บอทบันทึกไว้ + ตอบขั้นตอนโอนเงิน
//   - ลูกค้าส่งรูปสลิปโอนเงิน -> บอทแจ้งเตือนแอดมิน (push ส่วนตัว) ให้ไปตรวจสลิปในแชท LINE OA เอง
//   - แอดมินตรวจสลิปด้วยตาตัวเองแล้วไปกด "อนุมัติ" username นั้นในหน้า Admin Panel ของเว็บ (ของเดิม ไม่ต้องแก้)
// บอทนี้ "ไม่" อนุมัติบัญชีอัตโนมัติ และ "ไม่" แตะเงินจริง — เป็นแค่ตัวกลางรับข้อความ + เตือนแอดมิน

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxRZDCWRkt8ehIf73SYGxoIRZZ_9ZKyCQf5aUxrMzx6JwMCLMYdcy44ZgAqb0e8n52B/exec';

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64FromArrayBuffer(sig);
}

// เทียบแบบ constant-time กันเดา signature (Web Crypto API ไม่มี timingSafeEqual ให้ใช้ตรงๆ แบบ node:crypto)
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function verifySignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = await hmacSha256Base64(channelSecret, rawBody);
  return timingSafeEqualStr(expected, signature);
}

async function lineApi(path, body, accessToken) {
  await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  }).catch(() => {}); // ไม่ทำให้ webhook ทั้งก้อนพังถ้าส่งข้อความไม่สำเร็จ
}

function replyText(replyToken, text, accessToken) {
  return lineApi('message/reply', { replyToken, messages: [{ type: 'text', text }] }, accessToken);
}

function pushText(userId, text, accessToken) {
  return lineApi('message/push', { to: userId, messages: [{ type: 'text', text }] }, accessToken);
}

async function callAppsScript(action, payload, internalKey) {
  const body = { action, internalKey, ...payload };
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('payload', JSON.stringify(body));
  try {
    const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' });
    return await res.json();
  } catch (err) {
    return { ok: false, error: 'apps_script_unreachable', message: String(err) };
  }
}

const WELCOME_TEXT =
  'สวัสดีครับ 👋 ยินดีต้อนรับสู่ระบบข้อสอบเลื่อนฐานะ ส.อ. → จ.ส.อ. , จ.ส.อ. → นายร้อย และช่างอิเล็กทรอนิกส์\n\n' +
  'หากต้องการสมัครใช้งาน กรุณาพิมพ์ "username" ที่ต้องการใช้เข้าสู่ระบบ (ภาษาอังกฤษ/ตัวเลข ไม่มีเว้นวรรค) และสลิปเงินโอน ส่งมาในแชทนี้ได้เลยครับ';

function paymentInstructions(username, paymentInfoText) {
  return (
    `รับทราบ username: ${username} ครับ ✅\n\n` +
    paymentInfoText +
    '\n\nเมื่อโอนเงินแล้ว กรุณาส่ง "รูปสลิป" กลับมาในแชทนี้ แอดมินจะตรวจสอบและเปิดสิทธิ์ให้ครับ'
  );
}

const SLIP_RECEIVED_TEXT = 'ได้รับสลิปแล้วครับ 📩 รอแอดมินตรวจสอบและเปิดสิทธิ์ให้นะครับ';

async function handleEvent(event, env) {
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const internalKey = env.LINE_INTERNAL_KEY || '';
  const adminUserId = env.LINE_ADMIN_USER_ID || '';
  const paymentInfoText =
    env.LINE_PAYMENT_INFO_TEXT ||
    '⚠️ ยังไม่ได้ตั้งค่าราคา/บัญชีรับโอน กรุณาตั้งค่า Cloudflare env var ชื่อ LINE_PAYMENT_INFO_TEXT ก่อนใช้งานจริง';

  const userId = event.source && event.source.userId;

  if (event.type === 'follow') {
    if (event.replyToken) await replyText(event.replyToken, WELCOME_TEXT, accessToken);
    return;
  }

  if (event.type !== 'message' || !userId) return;

  if (event.message.type === 'text') {
    const text = String(event.message.text || '').trim();
    await callAppsScript('lineSaveLead', { lineUserId: userId, desiredUsername: text }, internalKey);
    if (event.replyToken) await replyText(event.replyToken, paymentInstructions(text, paymentInfoText), accessToken);
    return;
  }

  if (event.message.type === 'image') {
    await callAppsScript('lineSaveLead', { lineUserId: userId, slipReceived: true }, internalKey);
    if (event.replyToken) await replyText(event.replyToken, SLIP_RECEIVED_TEXT, accessToken);

    if (adminUserId) {
      const lead = await callAppsScript('lineGetLead', { lineUserId: userId }, internalKey);
      const desiredUsername = lead && lead.found ? lead.desiredUsername : '(ไม่ทราบ — ลูกค้ายังไม่ได้แจ้ง username)';
      await pushText(
        adminUserId,
        '🔔 มีลูกค้าส่งสลิปโอนเงินเข้ามาครับ\n' +
          `username ที่แจ้งไว้: ${desiredUsername}\n\n` +
          'เปิดแชท LINE OA เพื่อดูรูปสลิป แล้วไปกด "อนุมัติ" username นี้ในหน้า Admin Panel ของเว็บได้เลยครับ',
        accessToken
      );
    }
    return;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK - this endpoint only accepts LINE webhook POST requests', { status: 200 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-line-signature');

    const validSig = await verifySignature(rawBody, signature, env.LINE_CHANNEL_SECRET || '');
    if (!validSig) {
      return new Response('invalid signature', { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    const events = payload.events || [];
    ctx.waitUntil(Promise.all(events.map((e) => handleEvent(e, env).catch(() => {}))));

    return new Response('OK', { status: 200 });
  },
};
