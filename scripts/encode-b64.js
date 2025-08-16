// scripts/encode-b64.js — แปลง out/storage.json เป็น Base64 เพื่อใส่ใน GitHub Secret
const fs = require('fs');
const path = require('path');

const storagePath = path.join('out', 'storage.json');

if (!fs.existsSync(storagePath)) {
  console.error('ไม่พบ out/storage.json — รัน scripts/login-capture.js เพื่อสร้างก่อน');
  process.exit(1);
}

const b64 = fs.readFileSync(storagePath).toString('base64');
console.log('\\n=== BASE64 (ใส่ใน Secret: LOYVERSE_STORAGE_B64) ===\\n');
console.log(b64);
console.log('\\n=== END ===\\n');
