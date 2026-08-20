// Netlify Function: proxy คำขอจากไคลเอนต์ไปหา Google Apps Script backend
// เหตุผลที่ต้องมี: เบราว์เซอร์เรียก fetch() ตรงไปที่ script.google.com ข้าม origin ไม่ได้
// (Apps Script Web App ไม่ส่ง CORS header กลับมาให้ fetch() อ่านผลได้ ทั้งที่เปิด URL ตรงๆ ในเบราว์เซอร์ใช้ได้ปกติ)
// ฟังก์ชันนี้รันฝั่งเซิร์ฟเวอร์ของ Netlify เอง (ไม่ใช่ในเบราว์เซอร์) จึงไม่โดนข้อจำกัด CORS
// แล้วส่งผลลัพธ์กลับไปให้หน้าเว็บแบบ same-origin (เรียก /api จากเว็บ so-jorsor-exam.netlify.app เอง)

const SERVER_URL = 'https://script.google.com/macros/s/AKfycbynNa4WJCT_HWEFIXSzWeGjLm58uO5tJeruYZ_Ry526S_JVY26oFvnz5gAEXFM_ygtDCw/exec';

export default async (req) => {
  const url = new URL(req.url);
  const upstream = new URL(SERVER_URL);
  upstream.search = url.search; // forward query params (action=...&payload=...) ตรงๆ

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
};

export const config = {
  path: '/api',
};
