require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const dashboardService = require('./services/dashboard');
const googleSheets = require('./services/googleSheets');
const equipmentParser = require('./utils/equipmentParser');
const path = require('path');

const PORT = process.env.PORT || 3000;

const WHITELISTED_USERS = (process.env.WHITELISTED_LINE_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy_token',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'dummy_secret',
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// Serve LIFF Frontend
app.use(express.static(path.join(__dirname, 'public')));

// Phase 3 Endpoint: Get Config (LIFF ID)
app.get('/api/config', (req, res) => {
  res.json({ liffId: process.env.LIFF_ID || 'YOUR_LIFF_ID' });
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// Phase 3 Endpoint: LIFF Form Submission
app.post('/api/submit-liff', express.json(), async (req, res) => {
  try {
    const { logId, cases } = req.body; // 'cases' is an array of { recordData, equipmentData, aiJsonOutput }
    
    // 1. Verify User Auth (verify LIFF ID Token)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing Authorization header' });
    }
    const idToken = authHeader.split(' ')[1];
    
    // Verify token with LINE API
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: process.env.LINE_LOGIN_CHANNEL_ID || 'dummy_channel_id'
      })
    });
    
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      return res.status(401).json({ success: false, message: 'Invalid Token: ' + tokenData.error_description });
    }
    
    const userId = tokenData.sub;
    if (!WHITELISTED_USERS.includes(userId)) {
      console.log(`Unauthorized LIFF submit attempt by: ${userId}`);
      return res.status(403).json({ success: false, message: 'User not whitelisted' });
    }

    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ success: false, message: 'No cases provided' });
    }

    const results = [];

    // Process each case sequentially
    for (const caseItem of cases) {
      const { recordData, equipmentData, aiJsonOutput } = caseItem;
      const ccn = recordData.ccn;
      
      try {
        // 2. Reject Duplicate CCN
        const isDuplicate = await googleSheets.checkDuplicateCCN(ccn);
        if (isDuplicate) {
          results.push({ ccn, success: false, message: 'CCN นี้มีในระบบแล้ว กรุณาตรวจสอบ' });
          continue; // Skip to next case
        }

        // 3. Parse Equipment Data
        const parsedEq = {
            sheath4701_New: equipmentParser.parseInput(equipmentData.sheath4701, 'sheath4701').new,
            guideWire4711_New: equipmentParser.parseInput(equipmentData.guideWire4711, 'guideWire4711').new,
            guideWire4711_Re: equipmentParser.parseInput(equipmentData.guideWire4711, 'guideWire4711').re,
            dxCath4407_New: equipmentParser.parseInput(equipmentData.dxCath4407, 'dxCath4407').new,
            dxCath4407_Re: equipmentParser.parseInput(equipmentData.dxCath4407, 'dxCath4407').re,
            guiding4301_New: equipmentParser.parseInput(equipmentData.guiding4301, 'guiding4301').new,
            guiding4301_Re: equipmentParser.parseInput(equipmentData.guiding4301, 'guiding4301').re,
            ptcaWire4302_New: equipmentParser.parseInput(equipmentData.ptcaWire4302, 'ptcaWire4302').new,
            ptcaWire4302_Re: equipmentParser.parseInput(equipmentData.ptcaWire4302, 'ptcaWire4302').re,
            balloon4303_New: equipmentParser.parseInput(equipmentData.balloon4303, 'balloon4303').new,
            stent4305_New: equipmentParser.parseInput(equipmentData.stent4305, 'stent4305').new,
            other_Raw: equipmentData.other || '',
            other_Parsed: JSON.stringify(equipmentParser.parseOther(equipmentData.other)),
            generator: equipmentData.generator || '',
            lead: equipmentData.lead || ''
        };

        // Combine into final record
        const finalRecord = { ...recordData, ...parsedEq };
        
        // 4. Append to Patient_Records
        await googleSheets.appendPatientRecord(finalRecord);
        
        // 5. Generate Correction Diff for ML Training Data (Phase 2 Roadmap)
        // 6. Write back to Raw_Logs (Phase 2 Roadmap)
        
        results.push({ ccn, success: true });
      } catch (caseErr) {
        console.error(`Error processing case ${ccn}:`, caseErr);
        results.push({ ccn, success: false, message: 'เกิดข้อผิดพลาดภายในระบบ: ' + caseErr.message });
      }
    }
    
    res.json({ success: true, results });
  } catch (err) {
    console.error('Error in /api/submit-liff:', err);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

async function handleEvent(event) {
  const userId = event.source.userId;
  if (!WHITELISTED_USERS.includes(userId)) {
    console.log(`Blocked access from unauthorized user: ${userId}`);
    return Promise.resolve(null);
  }

  if (event.type === 'message' && event.message.type === 'image') {
    return handleImageUpload(event, userId);
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    if (params.get('action') === 'summary') {
      return handleSummaryRequest(event, params.get('period'));
    }
  }

  return Promise.resolve(null);
}

async function handleImageUpload(event, userId) {
  console.log(`Received image from authorized user: ${userId}`);

  // In production, this heavy lifting should be offloaded to Cloud Tasks/PubSub
  // to avoid LINE webhook timeout (must respond within 1-2s).
  // For demonstration, we simulate the orchestration here:
  
  // 1. Send immediate acknowledgment
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: 'กำลังประมวลผลรูปภาพจาก Document AI กรุณารอสักครู่...' }],
  });

  /*
  // Example Orchestration Pipeline (Moved to a background worker):
  
  // A) Upload to Storage & Get Signed URL
  const imageBuffer = await downloadLineImage(event.message.id);
  const imageUrl = await storageService.uploadImage(imageBuffer, event.message.id);
  
  // B) Document AI Form Parser Table Extraction
  const { rawRows, confidence, extractedNamesPerRow } = await visionService.analyzeImage(imageBuffer);
  
  if (confidence < 0.7) {
      // Notify user to retake photo if confidence is too low
      return notifyUser(userId, 'ภาพไม่ชัดเจน กรุณาถ่ายใหม่อีกครั้ง');
  }

  // C) Mask PHI Row by Row
  const { maskedText, mappings } = geminiService.maskPHI(rawRows, extractedNamesPerRow);

  // D) Gemini LLM Array Extraction
  const abbreviations = await googleSheets.getMedicalAbbreviations();
  const extractedJsonArray = await geminiService.extractData(maskedText, abbreviations);

  // E) Remap PHI tokens and Row validations
  const finalCases = geminiService.remapData(extractedJsonArray, mappings, extractedNamesPerRow);
  
  // F) Save to Raw_Logs and Generate LIFF URL
  // ...
  */
}

async function handleSummaryRequest(event, period) {
  console.log(`Received summary request: ${period}`);
  
  try {
    const summaryData = await dashboardService.getSummary(period);
    const flexMessage = dashboardService.generateFlexMessage(period, summaryData);
    
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [flexMessage],
    });
  } catch (error) {
    console.error("Failed to generate summary:", error);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'เกิดข้อผิดพลาดในการดึงข้อมูลสรุป' }],
    });
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});