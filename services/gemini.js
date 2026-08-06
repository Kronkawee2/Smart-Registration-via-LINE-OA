const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
2. Dates (พ.ศ. -> ค.ศ.): If the extracted year is in Thai Buddhist Era (e.g., 2569), you MUST subtract 543 and convert it to Gregorian year (e.g., 2026). Always format 'date' as YYYY-MM-DD.
3. Complications: If the complication field is "-", "None", "no", or "ไม่มี", you MUST normalize the output to strictly "None".
4. Procedure Taxonomy: Categorize the procedure strictly into one of these: "CAG", "CAG+PCI", "TPM", "PPM", "EPS+Ablation". If it does not match any, use "Other: [Original text]".
5. Medical Abbreviations: Do not mistakenly correct specialized abbreviations. Reference this dictionary: ${abbreviations}

Extract the following fields into a valid JSON ARRAY of objects. Each object should have:
- ccn: Case Record Number
- date: Date of procedure (YYYY-MM-DD format in AD year)
- age: Patient Age (number)
- hn: Hospital Number token (copy the <HN_ROWX_X> token exactly if found)
- an: Admission Number token (copy the <AN_ROWX_X> token exactly if found)
- idCard: ID Card Number token (copy the <ID_CARD_ROWX_X> token exactly if found)
- payment: Payment method/scheme
- hospital: Hospital Name
- timeIn: Time in (HH:MM)
- timeOut: Time out (HH:MM)
- doctor: Doctor Name
- scrub: Scrub Nurse Name
- circulate: Circulate Nurse Name
- monitor: Monitor Nurse Name
- indication: Medical Indication
- procedure: Procedure performed (Taxonomy or "Other: [...]")
- result: Procedure result
- punctureSite: Puncture Site
- complication: Complication description (Normalized to "None" if applicable)
- recommendation: Doctor's recommendation

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

          // Fallback if LLM missed the token assignment but it exists in mappings for this row
          if (!finalData.hn && mappings[`<HN_ROW${i}_0>`]) finalData.hn = mappings[`<HN_ROW${i}_0>`];
          if (!finalData.an && mappings[`<AN_ROW${i}_0>`]) finalData.an = mappings[`<AN_ROW${i}_0>`];
          if (!finalData.idCard && mappings[`<ID_CARD_ROW${i}_0>`]) finalData.idCard = mappings[`<ID_CARD_ROW${i}_0>`];

          // --- Validation Rules (Flags added for LIFF frontend review) ---
          finalData.validationErrors = [];
          
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
