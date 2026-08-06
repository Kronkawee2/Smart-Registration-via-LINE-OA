# Implementation Plan: Smart Patient Registration via LINE OA

## 1. Objective
พัฒนาระบบรับภาพถ่ายหน้าสมุดจดบันทึกด้วยลายมือจากเจ้าหน้าที่เทคนิคการแพทย์ส่วนหัวใจผ่าน LINE OA เพื่อช่วยอ่านข้อมูลเบื้องต้น บันทึกลง Google Sheet และจัดเตรียมข้อมูลสำหรับพิมพ์ส่งต่อแผนกบัญชี โดยเน้นความแม่นยำด้วย Human-in-the-loop

## 2. Scope of Work
- รับภาพถ่ายหน้าสมุดจด (1 ภาพมีหลายเคส) ผ่าน LINE OA
- สกัดข้อความและโครงสร้างตารางด้วย Google Cloud Document AI
- คัดกรองและ Mask ข้อมูลส่วนบุคคล (PHI) ก่อนส่งขึ้น Cloud
- จัดระเบียบข้อมูล เติมคำที่หาย และแปลงข้อมูลให้อยู่ในรูปแบบมาตรฐานด้วย Gemini 1.5 Flash
- แสดงผลข้อมูลที่สกัดได้บน LINE LIFF App เพื่อให้เจ้าหน้าที่ตรวจสอบและแก้ไข
- เจ้าหน้าที่กรอกจำนวนอุปกรณ์ (Equipment) ด้วยตนเองผ่าน Number Stepper ใน LIFF
- ตรวจสอบข้อมูลซ้ำซ้อน (Duplicate CCN) ก่อนบันทึกลง Google Sheet
- จัดข้อมูลให้อยู่ในรูปแบบสำหรับพิมพ์ส่งต่อแผนกบัญชี

## 3. Workflow
1. **Input**: เจ้าหน้าที่ส่งภาพถ่ายหน้าสมุดจดผ่าน LINE OA
2. **Table Extraction**: ระบบใช้ Document AI Form Parser ถอดรหัสภาพลายมือให้ออกมาเป็นโครงสร้างตาราง
3. **PHI Masking**: ระบบ Mask ข้อมูล HN, AN, ID Card และชื่อผู้ป่วย เพื่อความปลอดภัย
4. **Data Structuring**: Gemini 1.5 Flash สกัดข้อมูลแต่ละเคสและแปลงเป็น JSON Array
5. **Validation & Review**: ข้อมูลจะถูกคืนค่า Mask และส่งไปที่หน้าเว็บแอป (LIFF App) เจ้าหน้าที่จะรีวิว ตรวจสอบจุดผิดพลาด และกรอกจำนวนอุปกรณ์
6. **Storage**: เมื่อกดยืนยัน ระบบจะเช็ค CCN ซ้ำ และบันทึกข้อมูลลง Google Sheet
7. **Output**: เจ้าหน้าที่ใช้ข้อมูลใน Sheet สำหรับสรุปรายงาน หรือพิมพ์ส่งต่อแผนกบัญชี

## 4. Tools & Components
- **LINE OA & LIFF**: สำหรับรับรูปภาพ และ UI สำหรับแก้ไขข้อมูล (Frontend)
- **AI Models**:
  - **Google Cloud Document AI**: สำหรับสกัดข้อความพร้อมรักษาโครงสร้างตาราง
  - **Gemini 1.5 Flash**: สำหรับทำ Data Structuring (แปลงเป็น JSON)
- **Google Sheet**: สำหรับเก็บข้อมูลกลางและออกรายงาน

## 5. Data Fields
*ฟิลด์ที่ AI เป็นคนสกัดให้ (ดึงจากตาราง):*
- CCN
- Date (แปลงเป็นปี ค.ศ.)
- Name
- Age
- ID Card
- HN
- AN
- Payment
- Hospital
- Time in
- Time out
- Doctor
- Scrub
- Circulate
- Monitor
- Indication
- Procedure (Taxonomy)
- Result
- Puncture site
- Complication
- Recommendation

*ฟิลด์ที่เจ้าหน้าที่กรอกเองผ่าน LIFF (ไม่ใช้ AI เพื่อลดความเสี่ยงด้านสต๊อกสินค้า):*
- Sheath (4701)
- Guide wire (4711)
- Dx. Cath (4407)
- Guiding (4301)
- PTCA wire (4302)
- Balloon (4303)
- Stent (4305)
- Generator
- Lead
- Other (ระบุเอง)

## 6. Implementation Steps

**Phase 1: Preparation (✅ Completed)**
- เก็บตัวอย่างหน้าสมุดจดจริงและวางโครงสร้าง Data Fields
- ออกแบบ Google Sheet template

**Phase 2: Backend & AI Pipeline (✅ Completed)**
- เปลี่ยน OCR เป็น Document AI Form Parser
- เขียน Prompt ให้ Gemini ส่งค่ากลับมาเป็น JSON Array (รองรับหลายเคส)
- เขียนระบบ PHI Masking (ป้องกันข้อมูลรั่วไหล)
- เขียนระบบป้องกันข้อมูลซ้ำซ้อน (CCN Duplication)

**Phase 3: Frontend (LIFF App) (✅ Completed)**
- สร้างเว็บแอปพลิเคชันด้วย HTML/Tailwind CSS
- ทำ UI แสดงผลข้อมูลหลายเคสแบบ Carousel หรือ List
- สร้าง Number Stepper สำหรับให้เจ้าหน้าที่กรอก Equipment
- เชื่อมต่อ API `submit-liff` กับ Frontend

## 7. Risks & Controls
- **ตารางอ่านยาก**: ใช้ Document AI และให้เจ้าหน้าที่ตรวจแก้ผ่าน LIFF เสมอ (Human-in-the-loop)
- **ข้อมูลส่วนบุคคลรั่วไหล**: ใช้ PHI Masking ปิดบังข้อมูล HN/AN/ID Card/Name ก่อนส่งให้ Gemini
- **บันทึกข้อมูลซ้ำ**: มีฟังก์ชัน `checkDuplicateCCN` ตรวจสอบ Google Sheet ก่อนบันทึก
- **สต๊อกอุปกรณ์คลาดเคลื่อน**: นำฟิลด์ Equipment ออกจาก AI และให้เจ้าหน้าที่ใช้ Number Stepper ใน LIFF แทน