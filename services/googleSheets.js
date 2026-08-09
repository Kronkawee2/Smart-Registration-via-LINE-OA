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
  'other_Raw',
  'generator', 'lead',
];

const PATIENT_RECORD_HEADERS = [
  'No', 'CCN', 'Date', 'Name', 'Age', 'ID Card', 'HN', 'AN', 'Payment', 'Hospital',
  'Time in', 'Time out', 'Doctor', 'Scrub', 'Circulate', 'Monitor',
  'Indication', 'Procedure', 'Result', 'Puncture site', 'Complication', 'Recommendation',
  'Sheath(4701)', 'Guide wire(4711)_New', 'Guide wire(4711)_Re',
  'Dx.Cath(4407)_New', 'Dx.Cath(4407)_Re', 'Guiding(4301)_New', 'Guiding(4301)_Re',
  'PTCA wire(4302)_New', 'PTCA wire(4302)_Re', 'Balloon(4303)', 'Stent(4305)',
  'Other(Raw)', 'Generator', 'Lead'
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getCurrentMonthTab(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const targetDate = isNaN(d.getTime()) ? new Date() : d;
  const month = MONTH_NAMES[targetDate.getMonth()];
  const yearStr = targetDate.getFullYear().toString().slice(-2);
  return `${month}${yearStr}`;
}

// Single source of truth for which month tab a record belongs to. Both
// checkDuplicateCCN and appendPatientRecord call this with the same
// recordData, so they can never disagree on which tab to use.
function resolveTabName(recordData) {
  const date = recordData && recordData.date;
  return getCurrentMonthTab(date);
}

// Summary_Cache now holds only one row — the current month's rolling summary.
// The "today" row was dropped: staff submit data in batches a few times a
// month rather than daily, so a per-day summary rarely reflected anything.
const SUMMARY_CACHE_ROW = 2;

// --- Month-tab color scheme (applied once, right after a new month tab is created) ---

function hexToRgb01(hex) {
  const clean = hex.replace('#', '');
  return {
    red: parseInt(clean.substring(0, 2), 16) / 255,
    green: parseInt(clean.substring(2, 4), 16) / 255,
    blue: parseInt(clean.substring(4, 6), 16) / 255,
  };
}

const COLOR_GRAY_HEADER = hexToRgb01('#bdbdbd');
const COLOR_GREEN_HEADER = hexToRgb01('#b6d7a8');
const COLOR_TEAL_HEADER = hexToRgb01('#a3c5ca');
const COLOR_TEAL_DATA = hexToRgb01('#b0d7dd');
const COLOR_PINK_HEADER = hexToRgb01('#d4a6bd');
const COLOR_PINK_DATA = hexToRgb01('#ead1dc');

// Data rows get colored from row 2 through row 200 (0-indexed: rows 1-200, i.e.
// startRowIndex 1 / endRowIndex 200).
const DATA_ROWS_END_INDEX = 200;

// Group 2: equipment "New" columns (always green, header only).
const GREEN_HEADER_NAMES = [
  'Sheath(4701)', 'Guide wire(4711)_New', 'Dx.Cath(4407)_New',
  'Guiding(4301)_New', 'PTCA wire(4302)_New', 'Balloon(4303)', 'Stent(4305)',
];

// Group 3: staff columns (teal header + light-teal data rows).
const TEAL_HEADER_NAMES = ['Doctor', 'Scrub', 'Circulate', 'Monitor'];

// Group 4: equipment "Re" columns (pink header + light-pink data rows).
const PINK_HEADER_NAMES = [
  'Guide wire(4711)_Re', 'Dx.Cath(4407)_Re', 'Guiding(4301)_Re', 'PTCA wire(4302)_Re',
];

// Collapses a sorted list of column indices into inclusive [start, end] runs, so
// adjacent columns (e.g. Doctor-Scrub-Circulate-Monitor) become one repeatCell
// request instead of one per column.
function toContiguousRanges(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push([start, prev]);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  if (sorted.length > 0) ranges.push([start, prev]);
  return ranges;
}

// Converts a 0-indexed column index to its A1 column letter(s): 0=A, 1=B, ..., 25=Z, 26=AA, ...
function columnIndexToLetter(index) {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

const COLOR_OVERTIME_YELLOW = { red: 1, green: 0.92, blue: 0.23 };

function buildRepeatCellColorRequest(sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex, color) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}

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

  getCurrentMonthTab(date = new Date()) {
    return getCurrentMonthTab(date);
  }

  async ensureMonthTabExists(tabName) {
    const sheets = await this.getClient();

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
    });

    const existingSheets = (spreadsheet.data.sheets || []).map(
      (s) => s.properties?.title
    );

    if (existingSheets.includes(tabName)) {
      return;
    }

    let newSheetId = null;
    try {
      const createRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
      newSheetId = createRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
    } catch (err) {
      const alreadyExists = (err.message || '').includes('already exists');
      if (!alreadyExists) throw err;
      console.log(`Sheet "${tabName}" already exists (race condition handled).`);
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A1:AJ1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [PATIENT_RECORD_HEADERS] },
    });

    if (newSheetId !== null) {
      // Cosmetic only — never let a coloring failure block case-data writes to
      // this brand-new tab.
      try {
        await this.applyMonthTabColorScheme(newSheetId, tabName);
      } catch (colorErr) {
        console.warn(`Failed to apply color scheme to "${tabName}" (sheetId ${newSheetId}):`, colorErr.message);
      }
    }
  }

  /**
   * Colors a freshly-created month tab's header row (and, for staff/Re-equipment
   * columns, the data rows too) per the fixed scheme in PATIENT_RECORD_HEADERS.
   * Column positions are looked up dynamically via indexOf so a future header
   * reorder can't silently desync the colors.
   */
  async applyMonthTabColorScheme(sheetId, tabName) {
    const allIndexes = PATIENT_RECORD_HEADERS.map((_, i) => i);
    const namesToIndexes = (names) => names.map((h) => PATIENT_RECORD_HEADERS.indexOf(h)).filter((i) => i !== -1);

    const greenIdx = namesToIndexes(GREEN_HEADER_NAMES);
    const tealIdx = namesToIndexes(TEAL_HEADER_NAMES);
    const pinkIdx = namesToIndexes(PINK_HEADER_NAMES);
    const specialIdx = new Set([...greenIdx, ...tealIdx, ...pinkIdx]);
    const grayIdx = allIndexes.filter((i) => !specialIdx.has(i));

    const requests = [];

    const addHeaderOnly = (indices, color) => {
      toContiguousRanges(indices).forEach(([start, end]) => {
        requests.push(buildRepeatCellColorRequest(sheetId, 0, 1, start, end + 1, color));
      });
    };

    const addHeaderAndData = (indices, headerColor, dataColor) => {
      toContiguousRanges(indices).forEach(([start, end]) => {
        requests.push(buildRepeatCellColorRequest(sheetId, 0, 1, start, end + 1, headerColor));
        requests.push(buildRepeatCellColorRequest(sheetId, 1, DATA_ROWS_END_INDEX, start, end + 1, dataColor));
      });
    };

    addHeaderOnly(grayIdx, COLOR_GRAY_HEADER);
    addHeaderOnly(greenIdx, COLOR_GREEN_HEADER);
    addHeaderAndData(tealIdx, COLOR_TEAL_HEADER, COLOR_TEAL_DATA);
    addHeaderAndData(pinkIdx, COLOR_PINK_HEADER, COLOR_PINK_DATA);

    // Overtime highlight: if Time in falls outside 08:00-17:59, highlight both
    // Time in and Time out yellow. Time out's own value is never checked.
    const timeInIdx = PATIENT_RECORD_HEADERS.indexOf('Time in');
    const timeOutIdx = PATIENT_RECORD_HEADERS.indexOf('Time out');
    if (timeInIdx !== -1 && timeOutIdx !== -1) {
      const timeInColumnLetter = columnIndexToLetter(timeInIdx);
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: DATA_ROWS_END_INDEX,
                startColumnIndex: timeInIdx,
                endColumnIndex: timeInIdx + 1,
              },
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: DATA_ROWS_END_INDEX,
                startColumnIndex: timeOutIdx,
                endColumnIndex: timeOutIdx + 1,
              },
            ],
            booleanRule: {
              condition: {
                type: 'CUSTOM_FORMULA',
                values: [{
                  userEnteredValue: `=AND($${timeInColumnLetter}2<>"", OR($${timeInColumnLetter}2>=TIME(18,0,0), $${timeInColumnLetter}2<TIME(8,0,0)))`,
                }],
              },
              format: { backgroundColor: COLOR_OVERTIME_YELLOW },
            },
          },
          index: 0,
        },
      });
    }

    if (requests.length === 0) return;

    const sheets = await this.getClient();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { requests },
    });
  }

  async appendRawLog(logData) {
    const row = RAW_LOG_FIELDS.map((key) => logData[key] ?? '');
    const sheets = await this.getClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: 'Raw_Logs!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async updateRawLog(logId, correctedData) {
    console.log(`Updating Raw_Logs for logId: ${logId}`);
  }

  /**
   * Finds a single Raw_Logs row by logId. Returns null if not found.
   */
  async getRawLogById(logId) {
    const sheets = await this.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: 'Raw_Logs!A:I',
    });

    const rows = res.data.values || [];
    const row = rows.find((r) => r[0] === logId);
    if (!row) return null;

    const record = {};
    RAW_LOG_FIELDS.forEach((key, idx) => {
      record[key] = row[idx] ?? '';
    });
    return record;
  }

  async appendPatientRecord(recordData) {
    const tabName = resolveTabName(recordData);
    await this.ensureMonthTabExists(tabName);

    const row = PATIENT_RECORD_FIELDS.map((key) => recordData[key] ?? '');
    const sheets = await this.getClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A:AJ`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async checkDuplicateCCN(recordData) {
    const ccn = recordData && recordData.ccn;
    if (!ccn) return false;

    const tabName = resolveTabName(recordData);
    await this.ensureMonthTabExists(tabName);

    const sheets = await this.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${tabName}!B:B`,
    });

    const ccnList = res.data.values ? res.data.values.flat() : [];
    return ccnList.includes(ccn);
  }

  /**
   * Recomputes the dashboard summary for the current month straight from
   * Patient_Records (not the cache). Reads the whole tab every call — at the real
   * volume here (~160-180 cases/month) that's cheap; if volume grows a lot this
   * should switch to an incremental update instead of a full recalculation.
   */
  async calculateCurrentMonthSummary() {
    const emptySummary = { totalCases: 0, cagCount: 0, cagPciCount: 0, topEquipments: [] };

    const tabName = getCurrentMonthTab();
    const sheets = await this.getClient();

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    const existingSheets = (spreadsheet.data.sheets || []).map((s) => s.properties?.title);
    if (!existingSheets.includes(tabName)) {
      return emptySummary;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A:AJ`,
    });

    const rows = res.data.values || [];
    // Skip the header row, and any fully-blank row (e.g. a stray trailing row).
    const dataRows = rows.slice(1).filter((r) => r && r.some((cell) => String(cell || '').trim() !== ''));
    if (dataRows.length === 0) {
      return emptySummary;
    }

    const idx = (key) => PATIENT_RECORD_FIELDS.indexOf(key);
    const procedureIdx = idx('procedure');

    const EQUIPMENT_FIELDS = [
      { name: 'Sheath(4701)', keys: ['sheath4701_New'] },
      { name: 'Guide wire(4711)', keys: ['guideWire4711_New', 'guideWire4711_Re'] },
      { name: 'Dx.Cath(4407)', keys: ['dxCath4407_New', 'dxCath4407_Re'] },
      { name: 'Guiding(4301)', keys: ['guiding4301_New', 'guiding4301_Re'] },
      { name: 'PTCA wire(4302)', keys: ['ptcaWire4302_New', 'ptcaWire4302_Re'] },
      { name: 'Balloon(4303)', keys: ['balloon4303_New'] },
      { name: 'Stent(4305)', keys: ['stent4305_New'] },
    ];
    const equipmentTotals = EQUIPMENT_FIELDS.map((eq) => ({
      name: eq.name,
      count: 0,
      columnIndexes: eq.keys.map(idx),
    }));

    let cagCount = 0;
    let cagPciCount = 0;

    dataRows.forEach((row) => {
      // Exact match against the Procedure Taxonomy values gemini.js normalizes to
      // (see extractData() prompt rule #4) — "CAG" and "CAG+PCI" specifically.
      const procedureVal = String(row[procedureIdx] || '').trim();
      if (procedureVal === 'CAG') {
        cagCount++;
      } else if (procedureVal === 'CAG+PCI') {
        cagPciCount++;
      }

      equipmentTotals.forEach((eq) => {
        eq.columnIndexes.forEach((colIdx) => {
          const num = parseInt(row[colIdx], 10);
          if (!isNaN(num)) eq.count += num;
        });
      });
    });

    const topEquipments = equipmentTotals
      .map(({ name, count }) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      totalCases: dataRows.length,
      cagCount,
      cagPciCount,
      topEquipments,
    };
  }

  /**
   * Overwrites the current month's summary row.
   * Columns: period, last_updated, total_cases, cag_count, cag_pci_count, top_equipments.
   */
  async updateSummaryCache(data) {
    const row = [
      'this_month',
      new Date().toISOString(),
      data.totalCases,
      data.cagCount,
      data.cagPciCount,
      JSON.stringify(data.topEquipments ?? []),
    ];

    const sheets = await this.getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `Summary_Cache!A${SUMMARY_CACHE_ROW}:F${SUMMARY_CACHE_ROW}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  /**
   * Reads the current month's summary row.
   */
  async getSummaryCache() {
    const sheets = await this.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `Summary_Cache!A${SUMMARY_CACHE_ROW}:F${SUMMARY_CACHE_ROW}`,
    });

    const row = res.data.values?.[0];
    if (!row) return null;

    const [, lastUpdated, totalCases, cagCount, cagPciCount, topEquipments] = row;
    return {
      lastUpdated,
      totalCases: Number(totalCases) || 0,
      cagCount: Number(cagCount) || 0,
      cagPciCount: Number(cagPciCount) || 0,
      topEquipments: JSON.parse(topEquipments || '[]'),
    };
  }

  async getConfigMaster() {
    const sheets = await this.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: 'Config_Master!A1:Z1000',
    });

    const rows = res.data.values || [];
    if (rows.length === 0) {
      return { doctors: [], scrubs: [], circulates: [], monitors: [], hospitals: [], payments: [] };
    }

    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    const columnIndex = (name) => header.indexOf(name.toLowerCase());

    const collectColumn = (idx) => {
      if (idx === -1) return [];
      const values = rows.slice(1).map((row) => String(row[idx] || '').trim()).filter(Boolean);
      return Array.from(new Set(values));
    };

    return {
      doctors: collectColumn(columnIndex('Doctors')),
      scrubs: collectColumn(columnIndex('Scrubs')),
      circulates: collectColumn(columnIndex('Circulates')),
      monitors: collectColumn(columnIndex('Monitor')),
      hospitals: collectColumn(columnIndex('Hospitals')),
      payments: collectColumn(columnIndex('Payment')),
    };
  }

  async getMedicalAbbreviations() {
    return [
      "UA (Unstable Angina)", "CAG (Coronary Angiography)", "PCI (Percutaneous Coronary Intervention)",
      "DVD (Double Vessel Disease)", "RRA (Right Radial Artery)", "RFA (Right Femoral Artery)",
      "DAPT (Dual Antiplatelet Therapy)", "GDMT (Guideline-Directed Medical Therapy)",
      "HFrEF (Heart Failure with reduced Ejection Fraction)", "NSTEMI (Non-ST-Elevation Myocardial Infarction)"
    ].join(', ');
  }
}

const serviceInstance = new GoogleSheetsService();
serviceInstance.getCurrentMonthTab = getCurrentMonthTab;
serviceInstance.PATIENT_RECORD_HEADERS = PATIENT_RECORD_HEADERS;
serviceInstance.PATIENT_RECORD_FIELDS = PATIENT_RECORD_FIELDS;

module.exports = serviceInstance;