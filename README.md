# Smart Patient Registration via LINE OA

ระบบบันทึกข้อมูลเคสของแผนก Cath Lab (สวนหัวใจ) ผ่าน LINE Official Account — เจ้าหน้าที่ถ่ายภาพสมุดบันทึกเขียนด้วยลายมือส่งเข้า LINE ระบบใช้ OCR + AI แปลงลายมือเป็นข้อความ(Convert to text) ให้เจ้าหน้าที่ตรวจสอบ/แก้ไขผ่านหน้าเว็บ (LIFF) ก่อนบันทึกลง Google Sheet โดยอัตโนมัติ พร้อม Dashboard สรุปยอดรายเดือนสามารถกดดูได้ในแชท LINE

## ภาพรวมระบบ (Pipeline)

ถ่ายภาพสมุด → LINE OA → Cloud Run (webhook)
    → Cloud Tasks (แยกงานหนักออกจาก webhook กัน timeout)
    → Cloud Storage (เก็บภาพต้นฉบับ, auto-delete 7 วัน)
    → Document AI (OCR อ่านลายมือ)
    → Mask PHI (ปิดบัง ชื่อ/HN/AN/เลขบัตร ก่อนส่งออก API ภายนอก)
    → Gemini API (จัดโครงสร้างข้อมูล + แก้คำผิด + จัดหมวดหมู่)
    → Raw_Logs (Google Sheet — เก็บ log ทุกครั้ง)
    → LIFF Form (เจ้าหน้าที่ตรวจสอบ/แก้ไขก่อนยืนยัน)
    → Patient_Records (Google Sheet — แท็บแยกรายเดือนอัตโนมัติ)
    → แจ้งเตือนกลับเข้า LINE (สรุปผลบันทึก)

Rich Menu → Summary_Cache → Flex Message สรุปยอดเดือนปัจจุบัน

## Tech Stack

Backend เป็น Node.js + Express รันบน Cloud Run งานหนัก (OCR, เรียก Gemini) แยกออกจาก webhook handler ผ่าน Cloud Tasks เพราะ LINE บังคับให้ตอบกลับภายใน 1-2 วินาที ถ้าประมวลผลตรง ๆ ในนั้นจะ timeout

OCR ใช้ Google Document AI (Document OCR processor) — สมุดลายมือเล่มนี้ไม่มีเส้นตารางชัดเจน ทำให้ Document AI ตรวจจับโครงสร้างตารางไม่ได้ ระบบเลยอ่านข้อความทั้งหน้าแล้วส่งต่อให้ Gemini (gemini-flash-latest) เป็นคนแยกคอลัมน์เองด้วยแผนผังคอลัมน์ที่กำหนดไว้ใน prompt แทน

ฐานข้อมูลใช้ Google Sheets เป็นหลัก (4 แท็บ: Config_Master, Raw_Logs, Patient_Records ที่แยกแท็บรายเดือนอัตโนมัติ, Summary_Cache) ส่วนภาพต้นฉบับเก็บไว้ชั่วคราวใน Cloud Storage พร้อม lifecycle ลบอัตโนมัติหลัง 7 วัน

ฝั่งผู้ใช้งานเป็น LINE Messaging API + LINE Login + Rich Menu สำหรับรับภาพและแจ้งเตือน ส่วนหน้าจอตรวจสอบ/แก้ไขข้อมูลก่อนบันทึกเป็น LIFF (HTML/CSS/vanilla JS ธรรมดา ไม่ได้ใช้ framework)

## โครงสร้างโปรเจกต์

├── index.js                  # Express server, webhook, API endpoints, orchestration pipeline
├── package.json
├── public/
│   ├── liff.html              # หน้า LIFF สำหรับตรวจสอบ/แก้ไขข้อมูลเคส
│   └── js/
│       └── app.js             # Logic ฝั่ง frontend ของ LIFF form
├── services/
│   ├── vision.js              # เรียก Document AI, parse โครงสร้างเอกสาร, แยก/mask ชื่อคนไข้
│   ├── gemini.js              # เรียก Gemini API, mask/remap PHI, validate ข้อมูล
│   ├── googleSheets.js        # อ่าน/เขียน Google Sheets ทั้งหมด, คำนวณสรุปยอด, จัดการแท็บรายเดือน
│   ├── storage.js             # อัปโหลดภาพเข้า Cloud Storage
│   └── dashboard.js           # ประกอบ Flex Message สรุปยอด Dashboard
└── utils/
    └── equipmentParser.js     # Parse ข้อมูลอุปกรณ์ (รูปแบบ "1" หรือ "1+1" สำหรับ New/Re)

## Environment Variables

ตั้งค่าผ่าน Cloud Run Console (Variables & Secrets)

# Google Cloud
GCP_PROJECT_ID=
DOC_AI_PROCESSOR_ID=
GCP_STORAGE_BUCKET_NAME=
GOOGLE_SERVICE_ACCOUNT_EMAIL=

# Google Sheets
GOOGLE_SHEET_ID=

# Gemini API
GEMINI_API_KEY=

# LINE
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ID=
LINE_LOGIN_CHANNEL_ID=
LIFF_ID=

# Cloud Tasks
CLOUD_TASKS_LOCATION=
CLOUD_TASKS_QUEUE=
INTERNAL_TASK_SECRET=          # รหัสลับป้องกันคนนอกยิง request เข้า /internal/process-image ตรง ๆ

# App Config
PORT=8080                      
PUBLIC_BASE_URL=                # URL ของ Cloud Run service (ได้หลัง deploy ครั้งแรก)
WHITELISTED_LINE_USER_IDS=      # LINE User ID เจ้าหน้าที่ที่อนุญาต คั่นด้วยลูกน้ำ

**หมายเหตุ:** ไม่ต้องมี `GOOGLE_APPLICATION_CREDENTIALS` บน Cloud Run — ใช้ Service Account ที่ผูกกับตัว service โดยตรงแทน (auth อัตโนมัติ ปลอดภัยกว่า ไม่มี key file ให้หลุด)

## Google Sheet Schema

Sheet แบ่งเป็น 4 แท็บ — Config_Master เก็บรายชื่อ Doctors, Scrubs, Circulates, Monitor, Hospitals, Payment ไว้ให้ดึงเป็น dropdown ใน LIFF Raw_Logs เก็บ log ทุกครั้งที่มีภาพเข้ามา ทั้งค่าที่ AI อ่านได้กับค่าที่เจ้าหน้าที่แก้ไขจริง (เผื่อเอาไปใช้ fine-tune โมเดลเองในอนาคต) ข้อมูลเคสจริงจะอยู่ในแท็บที่ตั้งชื่อตามเดือน เช่น Aug26 ระบบสร้างแท็บใหม่ให้อัตโนมัติทุกเดือน พร้อม header และสีตารางตามที่กำหนดไว้ ส่วน Summary_Cache เก็บสรุปยอดของเดือนปัจจุบันไว้ให้ Rich Menu ดึงไปแสดง อัปเดตทุกครั้งที่มีการบันทึกเคสสำเร็จ

## การ Deploy

โปรเจกต์นี้ deploy ผ่าน **Cloud Shell** ไม่ต้องติดตั้ง `gcloud` CLI บนเครื่องตัวเอง

ครั้งแรกที่ deploy ต้องไปตั้ง Environment Variables ผ่าน Cloud Run Console เอง แล้วเอา Service URL ที่ได้ไปใส่เป็น Webhook URL กับ LIFF Endpoint URL ในฝั่ง LINE ด้วย

## ความปลอดภัย(PHI)

- ชื่อคนไข้, HN, AN, เลขบัตรประชาชน **ถูก mask ก่อนส่งเข้า Gemini API เสมอ** ไม่ส่งข้อมูลระบุตัวตนออกไปยัง external LLM โดยตรง
- ภาพต้นฉบับใน Cloud Storage มี lifecycle policy ลบอัตโนมัติหลัง 7 วัน
- ทุก endpoint ที่แตะข้อมูลเคส (`/api/submit-liff`, `/api/log/:logId`) ตรวจสอบ LIFF ID Token + whitelist ก่อนทำงานทุกครั้ง
- `/internal/process-image` (endpoint ที่ Cloud Tasks เรียกกลับมา) ป้องกันด้วย shared secret เปรียบเทียบแบบ timing-safe
- LINE User ID ที่อนุญาตใช้งานถูกจำกัดผ่าน whitelist (ไม่เปิดให้ทุกคนที่ add OA ใช้งานได้)

## ข้อจำกัด(Known Limitations)

- **OCR ลายมือไม่แม่นยำ 100%** — โดยเฉพาะตัวเลขที่เขียนคล้ายกัน (เช่น 6/2) เจ้าหน้าที่ต้องตรวจสอบทุกเคสในหน้า LIFF ก่อนยืนยันเสมอ ห้ามกดยืนยันโดยไม่ตรวจ
- **Document AI ไม่รองรับการตรวจจับตารางสำหรับสมุดลายมือเล่มนี้** — ระบบทำงานผ่านเส้นทาง "ไม่มีตาราง" (อ่านข้อความทั้งหน้าแล้วให้ Gemini แยกคอลัมน์เองด้วยแผนผังคอลัมน์ที่กำหนดไว้ใน prompt)
- **Dashboard แสดงแค่เดือนปัจจุบัน** ไม่มีประวัติย้อนหลัง (ข้อมูลดิบยังอยู่ครบใน Google Sheet แยกแท็บรายเดือน สามารถเปิดดูเองได้)
- ยังไม่มีการป้องกันการส่งภาพซ้ำตั้งแต่ต้นทาง (พึ่งการเช็ค CCN ซ้ำตอนบันทึกลง Sheet เป็นเกราะป้องกันหลัก)