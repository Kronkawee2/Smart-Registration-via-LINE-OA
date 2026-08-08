const { GoogleGenerativeAI } = require('@google/generative-ai');

function isValidYMD(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (!y || !m || !d) return false;
    if (m < 1 || m > 12) return false;
    const daysInMonth = new Date(y, m, 0).getDate();
    return d >= 1 && d <= daysInMonth;
}

function formatYMD(y, m, d) {
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Defense-in-depth against Gemini occasionally returning an ambiguous date format
 * despite the prompt instruction (e.g. "8/1/2026" instead of "2026-08-01").
 * googleSheets.js getCurrentMonthTab() parses this value with `new Date(date)` to
 * pick the month tab, so a wrong format can silently file a case under the wrong
 * month. Returns a strict YYYY-MM-DD string, or null if it can't be confidently parsed.
 */
function normalizeDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const trimmed = dateStr.trim();

    // Already strict-ish YYYY-M-D / YYYY-MM-DD
    let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
        const [, y, mo, d] = m;
        return isValidYMD(y, mo, d) ? formatYMD(y, mo, d) : null;
    }

    // Slash-separated, order ambiguous: X/Y/YYYY
    m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
        const y = m[3];
        const a = Number(m[1]);
        const b = Number(m[2]);

        let month, day;
        if (a > 12 && b <= 12) {
            day = a; month = b; // only valid as D/M/YYYY
        } else if (b > 12 && a <= 12) {
            month = a; day = b; // only valid as M/D/YYYY
        } else if (a <= 12 && b <= 12) {
            // Genuinely ambiguous — fall back to D/M/YYYY, matching the Thai/EU
            // convention used elsewhere in this app.
            day = a; month = b;
        } else {
            return null; // both > 12: not a valid date either way
        }

        return isValidYMD(y, month, day) ? formatYMD(y, month, day) : null;
    }

    return null;
}

class GeminiService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
  }

  /**
   * Masks PHI (HN, ID Card) from the text before sending to LLM.
   * Also removes the extracted names if they are still present in the text.
   * Processes row by row to keep tokens scoped per row.
   * @param {string[]} rawRows - The rows of text from OCR.
   * @param {string[]} extractedNamesPerRow - The names extracted earlier.
   * @returns {{ maskedText: string, mappings: Object }}
   */
  maskPHI(rawRows, extractedNamesPerRow) {
    const maskedRows = [];
    const mappings = {};

    rawRows.forEach((rowStr, rowIndex) => {
        let maskedRow = rowStr;
        
        // 1. Remove extracted name for this row
        const name = extractedNamesPerRow && extractedNamesPerRow[rowIndex];
        if (name) {
            maskedRow = maskedRow.replace(new RegExp(name, 'gi'), '<NAME_REMOVED>');
        }

        // 2. Mask ID Card (13 digits)
        const idCardRegex = /\b\d{1}\s?-?\s?\d{4}\s?-?\s?\d{5}\s?-?\s?\d{2}\s?-?\s?\d{1}\b/g;
        const idCardMatches = maskedRow.match(idCardRegex);
        if (idCardMatches) {
            idCardMatches.forEach((match, index) => {
                const token = `<ID_CARD_ROW${rowIndex}_${index}>`;
                mappings[token] = match.replace(/[\s-]/g, ''); 
                maskedRow = maskedRow.replace(match, token);
            });
        }

        // 3. Mask HN (Hospital Number)
        const hnRegex = /(?:HN|H\.N\.|H\.N)\s*[:.-]?\s*(\d{5,9})/gi;
        const hnMatches = [...maskedRow.matchAll(hnRegex)];
        if (hnMatches && hnMatches.length > 0) {
            hnMatches.forEach((match, index) => {
                const token = `<HN_ROW${rowIndex}_${index}>`;
                mappings[token] = match[1];
                maskedRow = maskedRow.replace(match[0], token);
            });
        }

        // 4. Mask AN (Admission Number)
        const anRegex = /(?:AN|A\.N\.|A\.N)\s*[:.-]?\s*(\d{5,9})/gi;
        const anMatches = [...maskedRow.matchAll(anRegex)];
        if (anMatches && anMatches.length > 0) {
            anMatches.forEach((match, index) => {
                const token = `<AN_ROW${rowIndex}_${index}>`;
                mappings[token] = match[1];
                maskedRow = maskedRow.replace(match[0], token);
            });
        }
        
        maskedRows.push(maskedRow);
    });

    return { maskedText: maskedRows.join('\n'), mappings };
  }

  /**
   * Calls Gemini to extract and structure the masked text.
   * @param {string} maskedText 
   * @param {string} abbreviations - Dictionary string of medical abbreviations
   */
  async extractData(maskedText, abbreviations = '') {
    const prompt = `
You are a medical data extraction assistant. Your task is to extract information from the following OCR text of a Cath Lab patient registration log.
The text has been masked for PHI. Preserve the mask tokens (e.g., <HN_0>, <ID_CARD_0>) exactly as they appear for each corresponding row.

CRITICAL INSTRUCTIONS & BUSINESS RULES:
1. Multi-Case Table: The image contains a table with MULTIPLE rows (cases). You MUST extract every row and return a JSON ARRAY of objects: [ {ccn: "..."}, {ccn: "..."} ]. Do not return a single object.
2. Dates: ALWAYS return 'date' in strict YYYY-MM-DD format, zero-padded (e.g. "2026-08-01",
   NEVER "8/1/2026" or "1/8/2026" or any other format). If the Thai Buddhist Era year is
   detected (e.g. 2569), subtract 543 first, then format as YYYY-MM-DD.
3. Complications: If the complication field is "-", "None", "no", or "ไม่มี", you MUST normalize the output to strictly "None".
4. Procedure Taxonomy: Categorize the procedure strictly into one of these: "CAG", "CAG+PCI", "TPM", "PPM", "EPS+Ablation". If it does not match any, use "Other: [Original text]".
5. Medical Abbreviations: Do not mistakenly correct specialized abbreviations. Reference this dictionary: ${abbreviations}
6. Column Discipline: Each field must come from its own column in the OCR text only.
   Never substitute data from an adjacent or different column (e.g., equipment codes/quantities
   must never appear in punctureSite, indication, procedure, result, complication, or recommendation).
7. Circulate vs Monitor Discipline: Circulate and Monitor are two SEPARATE columns in the table,
   with Circulate always positioned immediately before Monitor. Extract each strictly from its
   own column position — never swap them, and never guess which field a name belongs to based
   on the person's identity (the same person can be Circulate on one case and Monitor on
   another, so a name match against a known roster is NOT a valid signal for which field it goes in).

PHYSICAL NOTEBOOK COLUMN LAYOUT (left to right, as physically laid out in the source notebook):
Document AI cannot detect a table structure in this handwritten notebook, so you are working from
flat, unstructured OCR text with no column/row boundaries. Use this left-to-right layout as a
positional reading-order guide: fields appearing earlier in a case's text generally correspond to
columns earlier in this list, and fields appearing later correspond to columns later in this list.
1. No.
2. Date — this cell ALSO contains the CCN value combined together (split into
   separate 'date' and 'ccn' fields)
3. Name/ID — a busy multi-line cell containing Name, HN, AN, Age (ignore),
   AdmitDate (ignore), Room (ignore), and sometimes ID Card. Parse per the
   existing multi-line pattern rules for the name/HN/AN/idCard fields below.
4. Hospital, Payment — combined cell containing BOTH values together (split
   into separate 'hospital' and 'payment' fields)
5. Time (In, Out) — combined cell containing both start and end time together
   (split into separate 'timeIn' and 'timeOut' fields)
6. Contrast — exists in the notebook but is NOT part of the required output
   schema. Ignore this column's content entirely; do not let it bleed into
   any other field.
7. Dx. Pre cath — maps to the 'indication' field
8. Site of Procedure — maps to the 'punctureSite' field (anatomical puncture
   location, e.g. Right radial, RRA, RFA — NOT the CAG/PCI procedure type)
9. Procedure — maps to the 'procedure' field (CAG/CAG+PCI/etc taxonomy)
10. Dx. Post cath — maps to the 'result' field
11. Doctor
12. Scrub
13. Circulate
14. Monitor
15. Complication, Recommendation — combined cell containing BOTH values
    together (split into separate 'complication' and 'recommendation' fields)
16. Echo — exists in the notebook but is NOT part of the required output
    schema. Ignore this column's content entirely.
17. Equipment — handled separately via manual entry in the LIFF review form,
    NOT extracted by you. Ignore this column's content entirely.
This is especially important for disambiguating combined cells (items 2, 4, 5, 15 above) and for
distinguishing 'Site of Procedure' (punctureSite) from 'Procedure' (procedure) — these are two
DIFFERENT adjacent columns and must never be confused with each other despite the similar names.

Extract the following fields into a valid JSON ARRAY of objects. Each object should have:
- no: Running case number as written in the "No." column of the log (copy as-is, e.g. "1", "2")
- ccn: Case Record Number, format NN-NNNN (2-digit year, dash, 4-digit sequence), e.g.
  "26-0001", "26-0142". This is a short dashed code — never confuse it with hn/an
  (8 digits, no dash) or idCard (13 digits). Physically written in the same notebook
  cell as the Date (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 2) — split the two
  values apart into 'date' and 'ccn' rather than leaving either one blank.
- date: Date of procedure, AD (Gregorian) year, strict YYYY-MM-DD, e.g. "2026-08-01".
  If the Thai Buddhist Era year is detected (e.g. 2569), subtract 543 first. If the
  date is illegible, return an empty string rather than guessing.
- age: Patient age in years as a plain integer, e.g. "45", "67", "72". Digits only —
  never include units like "ปี" or "yrs". If illegible, return an empty string
  rather than guessing from another numeric column on the row.
- idCard: 13-digit Thai national ID card number token — copy the <ID_CARD_ROWX_X>
  mask token exactly if one is present in the text; never fabricate a number that
  isn't already masked as a token. Distinct from hn/an (8 digits) and ccn (NN-NNNN).
- hn: Hospital Number token — copy the <HN_ROWX_X> token exactly if found. Never
  copy the AN token here, even if only one of the two tokens appears on the row.
- an: Admission Number token — copy the <AN_ROWX_X> token exactly if found. Never
  copy the HN token here, even if only one of the two tokens appears on the row.
- payment: Payment scheme/coverage the patient is registered under, e.g. "สปสช.",
  "ประกันสังคม", "UCEP", "เบิกได้". This is a coverage/scheme name — never a hospital
  name or a monetary amount. Physically written in the same notebook cell as
  Hospital (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 4) — split the two values
  apart into 'hospital' and 'payment' rather than leaving either one blank.
- hospital: Name of the referring/receiving hospital as written in that column, e.g.
  "รพ.ศรีนครินทร์", "รพ.xxx". Not the cath lab site performing the procedure.
  Physically written in the same notebook cell as Payment (see PHYSICAL NOTEBOOK
  COLUMN LAYOUT, item 4) — split the two values apart rather than leaving either blank.
- timeIn: Procedure start time, strict 24-hour HH:MM, e.g. "09:15", "14:30". If
  illegible, return an empty string rather than guessing. Physically written in the
  same notebook cell as Time Out (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 5) —
  split the two values apart into 'timeIn' and 'timeOut'.
- timeOut: Procedure end time, strict 24-hour HH:MM, e.g. "10:40", "15:05". If
  illegible, return an empty string rather than guessing. Physically written in the
  same notebook cell as Time In (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 5) —
  split the two values apart into 'timeIn' and 'timeOut'.
- doctor: Name of the attending physician performing the procedure — the Doctor
  column, distinct from the Scrub/Circulate/Monitor nursing-staff columns.
- scrub: Name of the scrub nurse assisting on the sterile field — a nursing-staff
  column, distinct from Doctor/Circulate/Monitor.
- circulate: Circulate Nurse Name(s), read from the Circulate column specifically
  (see Circulate vs Monitor Discipline rule above — always the column immediately
  before Monitor). If multiple people are listed (up to 5), extract ALL of them
  joined by comma (e.g. "สมหญิง,อนุชา,ปิยะ"). Do not extract only the first name
  found, and never pull a name from the Monitor column instead.
- monitor: Monitor Nurse Name(s), read from the Monitor column specifically (see
  Circulate vs Monitor Discipline rule above — always the column immediately after
  Circulate). If multiple people are listed (up to 3), extract ALL of them joined
  by comma (e.g. "นภา,สมหญิง"). Do not extract only the first name found, and never
  pull a name from the Circulate column instead.
- indication: Clinical indication / reason for the procedure, from the "Dx. Pre cath"
  column (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 7), free text, e.g.
  "CAD with unstable angina", "Complete heart block". Copy as written; only expand
  an abbreviation if it matches the dictionary above.
- procedure: Procedure performed, from the "Procedure" column specifically (see
  PHYSICAL NOTEBOOK COLUMN LAYOUT, item 9 — a DIFFERENT column from "Site of
  Procedure"/punctureSite above despite the similar name), categorized strictly
  per the Procedure Taxonomy rule above (e.g. input "CAG+PCI to LAD" becomes
  "CAG+PCI"). If it doesn't match any listed category, use "Other: [Original text]".
- result: Outcome/result of the procedure, from the "Dx. Post cath" column (see
  PHYSICAL NOTEBOOK COLUMN LAYOUT, item 10), free text, e.g. "Successful PCI, TIMI
  III flow", "Successful implantation, threshold ปกติ".
- punctureSite: Puncture Site. Comes from the "Site of Procedure" column specifically
  (see PHYSICAL NOTEBOOK COLUMN LAYOUT, item 8) — a DIFFERENT column from "Procedure"
  (item 9, the 'procedure' field below), despite the similar name. Valid values look
  like anatomical locations or their abbreviations, e.g. "Right radial", "Left femoral",
  "RRA", "RFA", "RRA,RFA". This is NEVER equipment codes or quantities (e.g. NOT "4701",
  "1+1", "4316*1") and NEVER a CAG/PCI-style procedure category.
  If the column appears empty or unclear, return an empty string rather than guessing from adjacent columns.
- complication: Complication description, e.g. "Bleeding at puncture site", "Hematoma".
  Normalized to strictly "None" per the Complications rule above when the source
  says "-", "None", "no", or "ไม่มี". This is NEVER equipment codes or quantities.
  Physically written in the same notebook cell as Recommendation (see PHYSICAL
  NOTEBOOK COLUMN LAYOUT, item 15) — split the two values apart into 'complication'
  and 'recommendation' rather than leaving either one blank.
- recommendation: Doctor's post-procedure recommendation/follow-up plan, free text,
  e.g. "DAPT 1 ปี, F/U 1 เดือน", "CXR post-op, F/U Pacemaker clinic 1 สัปดาห์".
  Physically written in the same notebook cell as Complication (see PHYSICAL
  NOTEBOOK COLUMN LAYOUT, item 15) — split the two values apart rather than
  leaving either one blank.

OCR Text:
"""
${maskedText}
"""

Return ONLY the JSON array. Do not include markdown formatting or extra text.
`;

    const result = await this.model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Clean markdown if Gemini mistakenly includes it
    let cleanJson = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();
    
    try {
        return JSON.parse(cleanJson);
    } catch (error) {
        console.error("Failed to parse Gemini output as JSON", responseText);
        throw new Error("Invalid output format from LLM");
    }
  }

  /**
   * Remaps the masked values and the extracted names back into the structured objects.
   * Validates patterns for CCN, HN, and AN for each case.
   */
  remapData(extractedJsonArray, mappings, extractedNames) {
      if (!Array.isArray(extractedJsonArray)) {
          extractedJsonArray = [extractedJsonArray]; // Fallback if AI returned single object
      }

      const finalArray = [];

      for (let i = 0; i < extractedJsonArray.length; i++) {
          let jsonString = JSON.stringify(extractedJsonArray[i]);
          
          // Restore mappings
          for (const [token, value] of Object.entries(mappings)) {
              // We replace globally because the token might be present in this row
              jsonString = jsonString.replace(new RegExp(token, 'g'), value);
          }

          const finalData = JSON.parse(jsonString);
          
          // Explicitly set the name (match by index if available)
          finalData.name = extractedNames && extractedNames[i] ? extractedNames[i] : (finalData.name || '');

          // Fallback if the LLM missed the "No." column: use the row's position in the
          // table, since row order is already the source of truth for name/PHI remapping above.
          if (!finalData.no) finalData.no = String(i + 1);

          // Fallback if LLM missed the token assignment but it exists in mappings for this row
          if (!finalData.hn && mappings[`<HN_ROW${i}_0>`]) finalData.hn = mappings[`<HN_ROW${i}_0>`];
          if (!finalData.an && mappings[`<AN_ROW${i}_0>`]) finalData.an = mappings[`<AN_ROW${i}_0>`];
          if (!finalData.idCard && mappings[`<ID_CARD_ROW${i}_0>`]) finalData.idCard = mappings[`<ID_CARD_ROW${i}_0>`];

          // --- Validation Rules (Flags added for LIFF frontend review) ---
          finalData.validationErrors = [];

          // Name: vision.js parseNameIdCell() couldn't find a line that looked like
          // a name for this row — don't guess, flag it for manual entry instead.
          if (!finalData.name) {
              finalData.validationErrors.push('Name could not be extracted — please enter it manually');
          }

          // Date: normalize whatever format Gemini actually returned to strict
          // YYYY-MM-DD; flag for review instead of silently passing a bad value.
          if (finalData.date) {
              const normalizedDate = normalizeDateString(finalData.date);
              if (normalizedDate) {
                  finalData.date = normalizedDate;
              } else {
                  finalData.validationErrors.push(`Date format is invalid or ambiguous: "${finalData.date}"`);
              }
          }

          // CCN: YY-NNNN
          if (finalData.ccn && !/^\d{2}-\d{4}$/.test(finalData.ccn)) {
              finalData.validationErrors.push('CCN format is invalid (Expected YY-NNNN)');
          }
          
          // HN and AN: 8 digits
          if (finalData.hn && !/^\d{8}$/.test(finalData.hn)) {
              finalData.validationErrors.push('HN format is invalid (Expected 8 digits)');
          }
          if (finalData.an && !/^\d{8}$/.test(finalData.an)) {
              finalData.validationErrors.push('AN format is invalid (Expected 8 digits)');
          }

          finalData.requiresReview = finalData.validationErrors.length > 0;
          finalArray.push(finalData);
      }

      return finalArray;
  }
}

module.exports = new GeminiService();
