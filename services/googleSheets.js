const { google } = require('googleapis');

const RAW_LOG_FIELDS = [
  'logId', 'timestamp', 'lineUserId', 'imageUrl', 'rawOcrText', 'aiJsonOutput', 
  'status', 'humanCorrectedJson', 'correctionDiff'
];

const PATIENT_RECORD_FIELDS = [
  'no', 'ccn', 'date', 'name', 'age', 'idCard', 'hn', 'an', 'payment', 'hospital',
  'timeIn', 'timeOut', 'doctor', 'scrub', 'circulate', 'monitor',
  'indication', 'procedure', 'result', 'punctureSite', 'complication', 'recommendation',
  'sheath4701_New',
  'guideWire4711_New', 'guideWire4711_Re',
  'dxCath4407_New', 'dxCath4407_Re',
  'guiding4301_New', 'guiding4301_Re',
  'ptcaWire4302_New', 'ptcaWire4302_Re',
  'balloon4303_New',
  'stent4305_New',
  'other_Raw', 'other_Parsed',
  'generator', 'lead',
];

const SUMMARY_CACHE_ROWS = { today: 2, this_month: 3 };

class GoogleSheetsService {
  constructor() {
    this.sheetId = process.env.GOOGLE_SHEET_ID;
    this.auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.client = null;
  }

  async getClient() {
    if (!this.client) {
      const authClient = await this.auth.getClient();
      this.client = google.sheets({ version: 'v4', auth: authClient });
    }
    return this.client;
  }

  async appendRawLog(logData) {
    const row = RAW_LOG_FIELDS.map((key) => logData[key] ?? '');
    const sheets = await this.getClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: 'Raw_Logs!A:I', // Updated range for new columns
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async updateRawLog(logId, correctedData) {
    // Placeholder: To be implemented during Phase 3 (Frontend Integration)
    // 1. Search Raw_Logs for the row matching logId
    // 2. Update 'humanCorrectedJson' and 'correctionDiff' columns
    console.log(`Updating Raw_Logs for logId: ${logId}`);
  }

  async appendPatientRecord(recordData) {
    const row = PATIENT_RECORD_FIELDS.map((key) => recordData[key] ?? '');
    const sheets = await this.getClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: 'Patient_Records!A:AK',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async checkDuplicateCCN(ccn) {
    if (!ccn) return false;
    
    const sheets = await this.getClient();
    // Query column B (CCN) in Patient_Records
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: 'Patient_Records!B:B',
    });

    const ccnList = res.data.values ? res.data.values.flat() : [];
    return ccnList.includes(ccn);
  }

  async updateSummaryCache(period, data) {
    const rowNum = SUMMARY_CACHE_ROWS[period];
    if (!rowNum) throw new Error(`unknown summary period: ${period}`);

    const row = [
      period,
      new Date().toISOString(),
      data.totalCases,
      data.complicationCount,
      data.avgTimeMins,
      JSON.stringify(data.topEquipments ?? []),
    ];

    const sheets = await this.getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `Summary_Cache!A${rowNum}:F${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async getSummaryCache(period) {
    const rowNum = SUMMARY_CACHE_ROWS[period];
    if (!rowNum) throw new Error(`unknown summary period: ${period}`);

    const sheets = await this.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `Summary_Cache!A${rowNum}:F${rowNum}`,
    });

    const row = res.data.values?.[0];
    if (!row) return null;

    const [, lastUpdated, totalCases, complicationCount, avgTimeMins, topEquipments] = row;
    return {
      lastUpdated,
      totalCases: Number(totalCases) || 0,
      complicationCount: Number(complicationCount) || 0,
      avgTimeMins: Number(avgTimeMins) || 0,
      topEquipments: JSON.parse(topEquipments || '[]'),
    };
  }

  async getMedicalAbbreviations() {
    // Phase 2 Logic: Fetch from Config_Master dynamically
    // Returning a mock array for now. In reality, we read from Config_Master!A2:A
    return [
      "UA (Unstable Angina)", "CAG (Coronary Angiography)", "PCI (Percutaneous Coronary Intervention)",
      "DVD (Double Vessel Disease)", "RRA (Right Radial Artery)", "RFA (Right Femoral Artery)",
      "DAPT (Dual Antiplatelet Therapy)", "GDMT (Guideline-Directed Medical Therapy)", 
      "HFrEF (Heart Failure with reduced Ejection Fraction)", "NSTEMI (Non-ST-Elevation Myocardial Infarction)"
    ].join(', ');
  }
}

module.exports = new GoogleSheetsService();