# Loyverse Export (Items-only) → Save to Repo

สคริปต์นี้จะเข้า **รายการสินค้า (Items)** แล้วกด **ส่งออก** เพื่อดาวน์โหลด CSV ครบทุกรายการ (ไม่แตะหน้า Inventory เพื่อเลี่ยงตัวกรอง)
จากนั้น GitHub Actions จะคอมมิตไฟล์ลงในโฟลเดอร์ `data/` ของ repo โดย:
- `data/latest.csv` (ไฟล์ล่าสุด สำหรับอ้างอิง/ใช้งานต่อ)
- `data/loyverse_inventory_YYYY-MM-DD_HH-MM-SS.csv` (สำเนาพร้อมเวลาที่ UTC)

## วิธีใช้งาน (ครั้งแรก)
1) ติดตั้ง Node 18+
2) จับ Storage State หลังล็อกอิน Loyverse (บนเครื่องคุณ):
```bash
npm i
npx playwright install --with-deps
npx playwright install-deps
node scripts/login-capture.js
# ล็อกอิน Loyverse ให้สำเร็จ → กด Ctrl+C → จะได้ out/storage.json
```
3) แปลง storage.json → Base64 แล้วนำไปใส่ใน GitHub Secrets:
```bash
# วิธีที่ 1 (Node)
node scripts/encode-b64.js
# วิธีที่ 2 (bash)
base64 out/storage.json > storage.b64.txt
# วิธีที่ 3 (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("out/storage.json")) | Set-Content storage.b64.txt
```
4) เปิด GitHub → Settings → Secrets and variables → Actions → New repository secret
   - Name: `LOYVERSE_STORAGE_B64`
   - Value: (สตริง Base64 จากข้อ 3)
5) ตรวจไฟล์ `.github/workflows/run.yml` มีบรรทัดนี้แล้ว (ถ้ายังให้เพิ่ม):
```yaml
env:
  LOYVERSE_STORAGE_B64: ${{ secrets.LOYVERSE_STORAGE_B64 }}
```

## รันทดสอบ
- ไปที่แท็บ **Actions** → เลือก workflow → กด **Run workflow**  
ผลลัพธ์:
- ดูไฟล์ในโฟลเดอร์ `data/` ใน branch หลักของ repo
- ถ้ามีปัญหา ให้ดู Artifact (มี `out/error.png`) และ Log

## ปรับแต่ง
- เวลาไทย 09:00 ทุกวัน → ใช้ cron `0 2 * * *` (UTC)
- กำหนด URL หน้า Items เองได้ผ่าน env `LOYVERSE_ITEMS_URL`
- กำหนดโหมด headless ผ่าน env `HEADLESS` (ค่าเริ่มต้น `1` = headless เปิด, `0` = ปิดเพื่อดีบัก)
