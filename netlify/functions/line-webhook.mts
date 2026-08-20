// Netlify Function: LINE Official Account chatbot webhook
// จุดประสงค์ V1: รับข้อความจากลูกค้าที่ทักแชท LINE OA เพื่อ "ขายสิทธิ์เข้าใช้แอปข้อสอบ"
//   - ลูกค้าพิมพ์ username ที่ต้องการ -> บอทบันทึกไว้ + ตอบขั้นตอนโอนเงิน
//   - ลูกค้าส่งรูปสลิปโอนเงิน -> บอทแจ้งเตือนแอดมิน (push ส่วนตัว) ให้ไปตรวจสลิปในแชท LINE OA เอง
//   - แอดมินตรวจสลิปด้วยตาตัวเองแล้วไปกด "อนุมัติ" username นั้นในหน้า Admin Panel ของเว็บ (ของเดิมที่มีอยู่แล้ว)
// บอทนี้ "ไม่" อนุมัติบัญชีอัตโนมัติ และ "ไม่" แตะเงินจริง — เป็นแค่ตัวกลางรับข้อความ + เตือนแอดมิน
//
// ต้องตั้งค่า Netlify environment variables ก่อนใช้งานได้จริง (Site settings -> Environment variables):
//   LINE_CHANNEL_ACCESS_TOKEN  - จาก LINE Developers Console (Messaging API channel)
//   LINE_CHANNEL_SECRET        - จาก LINE Developers Console (Messaging API channel)
//   LINE_ADMIN_USER_ID         - LINE userId ส่วนตัวของแอดมิน (ใช้รับ push แจ้งเตือนเวลามีลูกค้าส่งสลิป)
//   LINE_INTERNAL_KEY          - ต้องตรงกับ INTERNAL_KEY ใน apps_script_code.gs (คนละตัวกับ ADMIN_KEY)
//   LINE_PAYMENT_INFO_TEXT     - ข้อความแจ้งราคา/บัญชีรับโอน (ถ้าไม่ตั้งจะใช้ข้อความ placeholder เตือนให้ไปตั้งค่า)
//
// ต้องตั้ง Webhook URL ใน LINE Developers Console เป็น: https://so-jorsor-exam.netlify.app/line-webhook

import crypto from 'node:crypto';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxRZDCWRkt8ehIf73SYGxoIRZZ_9ZKyCQf5aUxrMzx6JwMCLMYdcy44ZgAqb0e8n52B/exec';

const CHANNEL_ACCESS_TOKEN = Netlify.env.get('LINE_CHANNEL_ACCESS_TOKEN') || '';
const CHANNEL_SECRET = Netlify.env.get('LINE_CHANNEL_SECRET') || '';
const ADMIN_USER_ID = Netlify.env.get('LINE_ADMIN_USER_ID') || '';
const INTERNAL_KEY = Netlify.env.get('LINE_INTERNAL_KEY') || '';
const PAYMENT_INFO_TEXT = Netlify.env.get('LINE_PAYMENT_INFO_TEXT') ||
  '⚠️ ยังไม่ได้ตั้งค่าราคา/บัญชีรับโอน กรุณาตั้งค่า Netlify env var ชื่อ LINE_PAYMENT_INFO_TEXT ก่อนใช้งานจริง';

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !CHANNEL_SECRET) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  // เทียบแบบ constant-time กันเดา signature
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function lineApi(path: string, body: unknown) {
  await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  }).catch(() => {}); // ไม่ทำให้ webhook ทั้งก้อนพังถ้าส่งข้อความไม่สำเร็จ
}

function replyText(replyToken: string, text: string) {
  return lineApi('message/reply', { replyToken, messages: [{ type: 'text', text }] });
}

function pushText(userId: string, text: string) {
  return lineApi('message/push', { to: userId, messages: [{ type: 'text', text }] });
}

async function callAppsScript(action: string, payload: Record<string, unknown>) {
  const body = { action, internalKey: INTERNAL_KEY, ...payload };
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
  'สวัสดีครับ 👋 ยินดีต้อนรับสู่ระบบข้อสอบเลื่อนฐานะ ส.อ. → จ.ส.อ.\n\n' +
  'หากต้องการสมัครใช้งาน กรุณาพิมพ์ "username" ที่ต้องการใช้เข้าสู่ระบบ (ภาษาอังกฤษ/ตัวเลข ไม่มีเว้นวรรค) ส่งมาในแชทนี้ได้เลยครับ';

function paymentInstructions(username: string) {
  return (
    `รับทราบ username: ${username} ครับ ✅\n\n` +
    PAYMENT_INFO_TEXT +
    '\n\nเมื่อโอนเงินแล้ว กรุณาส่ง "รูปสลิป" กลับมาในแชทนี้ แอดมินจะตรวจสอบและเปิดสิทธิ์ให้ครับ'
  );
}

const SLIP_RECEIVED_TEXT = 'ได้รับสลิปแล้วครับ 📩 รอแอดมินตรวจสอบและเปิดสิทธิ์ให้นะครับ';

async function handleEvent(event: any) {
  const userId: string | undefined = event.source?.userId;

  if (event.type === 'follow') {
    if (event.replyToken) await replyText(event.replyToken, WELCOME_TEXT);
    return;
  }

  if (event.type !== 'message' || !userId) return;

  if (event.message.type === 'text') {
    const text = String(event.message.text || '').trim();
    await callAppsScript('lineSaveLead', { lineUserId: userId, desiredUsername: text });
    if (event.replyToken) await replyText(event.replyToken, paymentInstructions(text));
    return;
  }

  if (event.message.type === 'image') {
    await callAppsScript('lineSaveLead', { lineUserId: userId, slipReceived: true });
    if (event.replyToken) await replyText(event.replyToken, SLIP_RECEIVED_TEXT);

    if (ADMIN_USER_ID) {
      const lead = await callAppsScript('lineGetLead', { lineUserId: userId });
      const desiredUsername = lead && lead.found ? lead.desiredUsername : '(ไม่ทราบ — ลูกค้ายังไม่ได้แจ้ง username)';
      await pushText(
        ADMIN_USER_ID,
        '🔔 มีลูกค้าส่งสลิปโอนเงินเข้ามาครับ\n' +
          `username ที่แจ้งไว้: ${desiredUsername}\n\n` +
          'เปิดแชท LINE OA เพื่อดูรูปสลิป แล้วไปกด "อนุมัติ" username นี้ในหน้า Admin Panel ของเว็บได้เลยครับ'
      );
    }
    return;
  }
}

export default async (req: Request) => {
  const rawBody = await req.text();
  const signature = req.headers.get('x-line-signature');

  if (!verifySignature(rawBody, signature)) {
    return new Response('invalid signature', { status: 401 });
  }

  let payload: { events?: any[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const events = payload.events || [];
  await Promise.all(events.map((e) => handleEvent(e).catch(() => {})));

  return new Response('OK', { status: 200 });
};

export const config = {
  path: '/line-webhook',
};
