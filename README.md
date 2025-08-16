# Loyverse Export (Items-only) — Fast CI (v2.1)

เป้าหมาย: ลดเวลารอใน GitHub Actions (เลี่ยง `playwright install-deps` ที่ช้า), เพิ่ม Trace/Screenshot/Logs เพื่อดีบักได้ทันที

## ใช้ยังไง (สั้นๆ)
1) จับ `out/storage.json` ด้วย `node scripts/login-capture.js` (ทำครั้งแรกบนเครื่องคุณ)
2) `node scripts/encode-b64.js` แล้วเอาสตริง Base64 ไปใส่ Secret: `LOYVERSE_STORAGE_B64`
3) Push ทั้งโฟลเดอร์นี้ขึ้น repo แล้วกด **Run workflow**

- ถ้าล้มเหลว: ไปดู **Artifacts** → `out-folder` (มี `error.png` และ `trace.zip`), และดู logs (`DEBUG=pw:api`).

