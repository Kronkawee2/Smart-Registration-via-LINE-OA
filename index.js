require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const line = require('@line/bot-sdk');
const { CloudTasksClient } = require('@google-cloud/tasks');
const dashboardService = require('./services/dashboard');
const googleSheets = require('./services/googleSheets');
const visionService = require('./services/vision');
const geminiService = require('./services/gemini');
const storageService = require('./services/storage');
const equipmentParser = require('./utils/equipmentParser');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CONFIDENCE_THRESHOLD = 0.7;

const WHITELISTED_USERS = (process.env.WHITELISTED_LINE_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy_token',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'dummy_secret',
};

// Same format rules as gemini.js remapData() and the client-side check in app.js.
// Enforced again here server-side as defense-in-depth — the LIFF form's validation
// can be bypassed (direct API call, stale client, etc.), so a bad CCN/HN/AN must
// still be caught before it reaches Patient_Records.
const CCN_PATTERN = /^\d{2}-\d{4}$/;
const HN_AN_PATTERN = /^\d{8}$/;

function validateRecordFormat(recordData) {
  if (!CCN_PATTERN.test(recordData.ccn || '')) {
    return 'รูปแบบ CCN ไม่ถูกต้อง (ต้องเป็น NN-NNNN เช่น 26-0001)';
  }
  if (!HN_AN_PATTERN.test(recordData.hn || '')) {
    return 'รูปแบบ HN ไม่ถูกต้อง (ต้องเป็นตัวเลข 8 หลัก)';
  }
  if (!HN_AN_PATTERN.test(recordData.an || '')) {
    return 'รูปแบบ AN ไม่ถูกต้อง (ต้องเป็นตัวเลข 8 หลัก)';
  }
  return null;
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const tasksClient = new CloudTasksClient();

const app = express();

// Serve LIFF Frontend
app.use(express.static(path.join(__dirname, 'public')));

// Phase 3 Endpoint: Get Config (LIFF ID)
app.get('/api/config', (req, res) => {
  res.json({ liffId: process.env.LIFF_ID || 'YOUR_LIFF_ID' });
});

// Phase 3 Endpoint: Doctor/Scrub/Circulate/Hospital suggestions for the LIFF review form,
// sourced from the Config_Master tab so admins can add new staff by editing the sheet.
// Left unauthenticated (no whitelist check), same as /api/config above: it's read-only
// reference data with no PHI, and it never touches Patient_Records — worst case someone
// unauthorized sees a list of staff names, not patient data. /api/submit-liff, which
// actually writes records, keeps its whitelist check untouched.
app.get('/api/config-master', async (req, res) => {
  try {
    const data = await googleSheets.getConfigMaster();
    res.json(data);
  } catch (err) {
    console.error('Error in /api/config-master:', err);
    res.status(500).json({ doctors: [], scrubs: [], circulates: [], monitors: [], hospitals: [], payments: [] });
  }
});

// Verifies a LIFF ID token against LINE's OAuth verify endpoint and confirms the
// user is on the whitelist. Shared by /api/log/:logId and /api/submit-liff so both
// PHI-bearing endpoints authenticate identically (defense-in-depth alongside the
// hard-to-guess logId UUID itself).
async function verifyLiffAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing Authorization header' };
  }
  const idToken = authHeader.split(' ')[1];

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
    return { ok: false, status: 401, message: 'Invalid Token: ' + tokenData.error_description };
  }

  const userId = tokenData.sub;
  if (!WHITELISTED_USERS.includes(userId)) {
    console.log(`Unauthorized LIFF request attempt by: ${userId}`);
    return { ok: false, status: 403, message: 'User not whitelisted' };
  }

  return { ok: true, userId };
}

// Phase 3 Endpoint: LIFF form reads the AI-extracted cases for a given logId
// instead of using mock data.
app.get('/api/log/:logId', async (req, res) => {
  try {
    const auth = await verifyLiffAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.message });
    }

    const log = await googleSheets.getRawLogById(req.params.logId);
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }

    let cases = [];
    try {
      cases = JSON.parse(log.aiJsonOutput || '[]');
    } catch (parseErr) {
      console.error(`Failed to parse aiJsonOutput for logId ${req.params.logId}`);
      cases = [];
    }

    res.json(cases);
  } catch (err) {
    console.error('Error in /api/log/:logId:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Verifies that a request to /internal/process-image actually came from our
// Cloud Tasks queue, via a shared secret header, so outsiders can't trigger
// the heavy OCR/Gemini pipeline directly.
function verifyInternalTaskSecret(req, res, next) {
  const expected = process.env.INTERNAL_TASK_SECRET;
  const provided = req.header('X-Internal-Task-Secret');

  if (!expected || !provided) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const isValid =
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!isValid) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// Cloud Tasks calls back into this endpoint to run the heavy OCR + Gemini
// pipeline outside of the 1-2s LINE webhook response window.
app.post('/internal/process-image', express.json(), verifyInternalTaskSecret, async (req, res) => {
  const { messageId, userId } = req.body || {};
  if (!messageId || !userId) {
    return res.status(400).json({ error: 'messageId and userId are required' });
  }

  try {
    await processImagePipeline(messageId, userId);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Unhandled error in /internal/process-image:', err.message);
    res.status(500).json({ success: false });
  }
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
    const auth = await verifyLiffAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
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
        // 2. Reject bad CCN/HN/AN format before it ever reaches the sheet
        const formatError = validateRecordFormat(recordData);
        if (formatError) {
          results.push({ ccn, success: false, message: formatError });
          continue; // Skip to next case
        }

        // 3. Reject Duplicate CCN
        const isDuplicate = await googleSheets.checkDuplicateCCN(recordData);
        if (isDuplicate) {
          results.push({ ccn, success: false, message: 'CCN นี้มีในระบบแล้ว กรุณาตรวจสอบ' });
          continue; // Skip to next case
        }

        // 4. Parse Equipment Data
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
            generator: equipmentData.generator || '',
            lead: equipmentData.lead || ''
        };

        // Combine into final record
        const finalRecord = { ...recordData, ...parsedEq };
        
        // 5. Append to Patient_Records
        await googleSheets.appendPatientRecord(finalRecord);
        
        // 6. Generate Correction Diff for ML Training Data (Phase 2 Roadmap)
        // 7. Write back to Raw_Logs (Phase 2 Roadmap)
        
        results.push({ ccn, success: true });
      } catch (caseErr) {
        console.error(`Error processing case ${ccn}:`, caseErr);
        results.push({ ccn, success: false, message: 'เกิดข้อผิดพลาดภายในระบบ: ' + caseErr.message });
      }
    }
    
    // Push a confirmation back into the LINE chat so the technician has a record of
    // the save even after closing the LIFF window. Wrapped in its own try/catch so a
    // push failure never affects the response the frontend is waiting on.
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;
    if (successCount > 0) {
      try {
        let summaryText = `✅ บันทึกข้อมูลสำเร็จ ${successCount} เคส`;
        if (failureCount > 0) {
          summaryText = `✅ บันทึกสำเร็จ ${successCount} เคส\n⚠️ ไม่สำเร็จ ${failureCount} เคส กรุณาเปิด LIFF ตรวจสอบอีกครั้ง`;
        }
        await client.pushMessage({
          to: auth.userId,
          messages: [{ type: 'text', text: summaryText }],
        });
      } catch (pushErr) {
        console.error('Failed to push submit-liff confirmation message:', pushErr.message);
      }
    }

    // Recalculate and cache the dashboard summary, but only if at least one
    // successfully-saved case actually landed in the *current* month's tab —
    // Summary_Cache only ever represents "this month", so backfilling a past
    // month's case should not touch it. Wrapped in its own try/catch, same
    // reasoning as the push message above: never let this affect the main response.
    try {
      const currentMonthTab = googleSheets.getCurrentMonthTab();
      const hasCurrentMonthSuccess = cases.some((caseItem, i) => {
        const result = results[i];
        if (!result || !result.success) return false;
        const recordTab = googleSheets.getCurrentMonthTab(caseItem.recordData && caseItem.recordData.date);
        return recordTab === currentMonthTab;
      });

      if (hasCurrentMonthSuccess) {
        const summaryData = await googleSheets.calculateCurrentMonthSummary();
        await googleSheets.updateSummaryCache(summaryData);
      }
    } catch (summaryErr) {
      console.error('Failed to refresh Summary_Cache after submit-liff:', summaryErr.message);
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
      return handleSummaryRequest(event);
    }
  }

  return Promise.resolve(null);
}

async function handleImageUpload(event, userId) {
  console.log('Received image from authorized user, acknowledging and enqueuing.');

  // 1. Send immediate acknowledgment (LINE requires a webhook reply within 1-2s,
  // well before Document AI + Gemini could realistically finish).
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: 'กำลังประมวลผลรูปภาพจาก Document AI กรุณารอสักครู่...' }],
  });

  // 2. Hand the heavy lifting off to Cloud Tasks, which calls back into
  // POST /internal/process-image outside the webhook's response window.
  try {
    await enqueueImageProcessingTask(event.message.id, userId);
  } catch (err) {
    console.error('Failed to enqueue image processing task:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการเริ่มประมวลผลภาพ กรุณาลองส่งภาพใหม่อีกครั้ง');
  }
}

async function enqueueImageProcessingTask(messageId, userId) {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.CLOUD_TASKS_LOCATION;
  const queue = process.env.CLOUD_TASKS_QUEUE;
  const baseUrl = process.env.PUBLIC_BASE_URL;

  if (!projectId || !location || !queue || !baseUrl) {
    throw new Error('Cloud Tasks is not fully configured (GCP_PROJECT_ID / CLOUD_TASKS_LOCATION / CLOUD_TASKS_QUEUE / PUBLIC_BASE_URL)');
  }

  const parent = tasksClient.queuePath(projectId, location, queue);
  const url = `${baseUrl}/internal/process-image`;
  const payload = { messageId, userId };

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Task-Secret': process.env.INTERNAL_TASK_SECRET || '',
      },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
  };

  await tasksClient.createTask({ parent, task });
}

// Downloads the raw image bytes for a LINE message via the Messaging API
// content endpoint.
async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${config.channelAccessToken}` },
  });

  if (!res.ok) {
    throw new Error(`LINE content API returned status ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function notifyUser(userId, text) {
  try {
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('Failed to push notification to user:', err.message);
  }
}

// The full orchestration pipeline: called by POST /internal/process-image
// (via Cloud Tasks), never directly from the webhook handler.
async function processImagePipeline(messageId, userId) {
  console.log('Processing image for user (id withheld from logs).');

  // A) Download the image from LINE
  let imageBuffer;
  try {
    imageBuffer = await downloadLineImage(messageId);
  } catch (err) {
    console.error('Step A (download image from LINE) failed:', err.message);
    await notifyUser(userId, 'ไม่สามารถดาวน์โหลดรูปภาพจาก LINE ได้ กรุณาลองส่งใหม่อีกครั้ง');
    return;
  }

  // B) Upload into Cloud Storage
  let imageUrl;
  try {
    imageUrl = await storageService.uploadImageBuffer(imageBuffer, messageId);
  } catch (err) {
    console.error('Step B (upload to Cloud Storage) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการบันทึกรูปภาพ กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // C) OCR with Document AI
  let rawRows, confidence, extractedNamesPerRow, orderedPatientNames;
  try {
    ({ rawRows, confidence, extractedNamesPerRow, orderedPatientNames } = await visionService.analyzeImage(imageBuffer));
  } catch (err) {
    console.error('Step C (Document AI OCR) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการอ่านข้อมูลจากภาพ กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // D) Confidence gate
  if (confidence < CONFIDENCE_THRESHOLD) {
    console.log(`Step D: OCR confidence ${confidence.toFixed(2)} below threshold ${CONFIDENCE_THRESHOLD}, requesting retake.`);
    await notifyUser(userId, 'ภาพไม่ชัดเจนเพียงพอสำหรับการประมวลผล กรุณาถ่ายภาพใหม่ให้ชัดเจนขึ้นแล้วส่งอีกครั้ง');
    return;
  }

  // E) Mask PHI row by row
  let maskedText, mappings;
  try {
    ({ maskedText, mappings } = geminiService.maskPHI(rawRows, extractedNamesPerRow));
  } catch (err) {
    console.error('Step E (mask PHI) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการประมวลผลข้อมูล กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // F) Gemini extraction
  let extractedJsonArray;
  try {
    const abbreviations = await googleSheets.getMedicalAbbreviations();
    extractedJsonArray = await geminiService.extractData(maskedText, abbreviations);
  } catch (err) {
    console.error('Step F (Gemini extractData) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการสกัดข้อมูลด้วย AI กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // G) Remap PHI tokens back in and run row validations. Uses orderedPatientNames
  // (not extractedNamesPerRow) — on the no-table fallback OCR path,
  // extractedNamesPerRow is sparse/index-aligned to raw page lines (needed by
  // maskPHI above to mask the right row), while remapData needs a dense,
  // appearance-ordered list to assign names back to cases in the same order
  // Gemini extracted them.
  let finalCases;
  try {
    finalCases = geminiService.remapData(extractedJsonArray, mappings, orderedPatientNames);
  } catch (err) {
    console.error('Step G (remapData) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการประมวลผลข้อมูล กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // H) Write to Raw_Logs
  const logId = crypto.randomUUID();
  try {
    const rawOcrText = Array.isArray(rawRows) ? rawRows.join('\n') : '';
    await googleSheets.appendRawLog({
      logId,
      timestamp: new Date().toISOString(),
      lineUserId: userId,
      imageUrl,
      rawOcrText,
      aiJsonOutput: JSON.stringify(finalCases),
      status: finalCases.some((c) => c.requiresReview) ? 'requires_review' : 'pending_review',
      humanCorrectedJson: '',
      correctionDiff: '',
    });
  } catch (err) {
    console.error('Step H (write Raw_Logs) failed:', err.message);
    await notifyUser(userId, 'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // I) Build the LIFF review link and push it back to the user
  try {
    const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?logId=${logId}`;
    await client.pushMessage({
      to: userId,
      messages: [
        {
          type: 'template',
          altText: 'ข้อมูลพร้อมให้ตรวจสอบแล้ว',
          template: {
            type: 'buttons',
            text: `พบข้อมูล ${finalCases.length} เคส กรุณาตรวจสอบก่อนบันทึก`,
            actions: [{ type: 'uri', label: 'ตรวจสอบข้อมูล', uri: liffUrl }],
          },
        },
      ],
    });
  } catch (err) {
    console.error('Step I (send LIFF link) failed:', err.message);
  }
}

async function handleSummaryRequest(event) {
  console.log('Received summary request');
  
  try {
    const summaryData = await dashboardService.getSummary();
    const flexMessage = dashboardService.generateFlexMessage(summaryData);
    
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