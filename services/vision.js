const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

// Thai patient-name honorifics that mark the start of a name line in the
// notebook (used by extractPatientNamesFromRawText and the no-table fallback
// path in analyzeImage — see the PHI masking gap fix below).
const NAME_PREFIX_PATTERN = /^(นาย|นาง|นางสาว|ด\.ช\.|ด\.ญ\.)/;

class VisionService {
  constructor() {
    this.client = new DocumentProcessorServiceClient();
  }

  /**
   * Performs OCR on an image buffer using Document AI Form Parser.
   * Extracts table structure accurately to prevent cross-column bleeding.
   * @param {Buffer} imageBuffer - The image buffer to analyze.
   * @returns {Promise<{ rawText: string, extractedNames: string[] }>}
   */
  async analyzeImage(imageBuffer) {
    const projectId = process.env.GCP_PROJECT_ID;
    const location = 'us'; // Format is 'us' or 'eu'
    const processorId = process.env.DOC_AI_PROCESSOR_ID; // The Form Parser processor ID

    if (!processorId) {
       throw new Error("DOC_AI_PROCESSOR_ID is not configured. Please set this in .env");
    }

    const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    const request = {
      name,
      rawDocument: {
        content: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const [result] = await this.client.processDocument(request);
    const { document } = result;

    if (!document) {
      return { rawRows: [], confidence: 0, extractedNamesPerRow: [], orderedPatientNames: [] };
    }

    const rawText = document.text;
    const tables = [];
    let totalConfidence = 0;
    let cellCount = 0;

    const getTextWithNewlines = (textAnchor, text) => {
        if (!textAnchor || !textAnchor.textSegments) return '';
        return textAnchor.textSegments.map(segment => {
            const startIndex = segment.startIndex || 0;
            const endIndex = segment.endIndex;
            return text.substring(startIndex, endIndex);
        }).join('').trim(); // Retain newlines for Name/ID cell parsing
    };

    const extractedNamesPerRow = [];

    // --- [TEMP DEBUG] Table-structure diagnostic logging. ---
    // Added to investigate why Doctor/Scrub/Circulate/Monitor come back empty
    // after switching the Document AI processor from "Document OCR" to "Form
    // Parser" — suspected cause is Form Parser detecting the handwritten table
    // as several small per-row tables with inconsistent column counts, which
    // would desync the positional cell-index assembly below. Safe to delete
    // this whole block (and the two console.log calls inside the loops further
    // down, also marked [TEMP DEBUG]) once the real fix for column mapping lands.
    let debugTotalTableCount = 0;
    if (document.pages) {
        document.pages.forEach(page => {
            if (page.tables) debugTotalTableCount += page.tables.length;
        });
    }
    console.log(`[DEBUG] Found ${debugTotalTableCount} tables in image`);
    // --- [/TEMP DEBUG] ---

    if (document.pages) {
        document.pages.forEach(page => {
            if (page.tables) {
                page.tables.forEach((table, tableIndex) => {
                    const parsedTable = [];
                    // Find Name/ID column index from headerRows
                    let nameColumnIndex = 3; // Fallback index
                    let headerFound = false;

                    // [TEMP DEBUG] table shape — see block comment above.
                    const debugHeaderRowCount = table.headerRows ? table.headerRows.length : 0;
                    const debugBodyRowCount = table.bodyRows ? table.bodyRows.length : 0;
                    console.log(`[DEBUG] Table ${tableIndex}: ${debugHeaderRowCount} header rows, ${debugBodyRowCount} body rows`);
                    // [/TEMP DEBUG]

                    if (table.headerRows) {
                        table.headerRows.forEach(row => {
                            row.cells.forEach((cell, index) => {
                                const cellText = getTextWithNewlines(cell.layout.textAnchor, rawText);
                                if (cellText.match(/ชื่อ|Name/i)) {
                                    nameColumnIndex = index;
                                    headerFound = true;
                                }
                            });
                        });
                    }

                    if (!headerFound) {
                        console.warn(`Could not detect "Name/ชื่อ" in table headers. Falling back to column index ${nameColumnIndex}.`);
                    }

                    // Process body rows only to get case data
                    if (table.bodyRows) {
                        table.bodyRows.forEach((row, rowIndex) => {
                            const rowData = [];
                            let rowName = null;

                            // [TEMP DEBUG] column count per row, and a full raw cell dump for
                            // the first row of each table — see block comment above.
                            console.log(`[DEBUG] Table ${tableIndex} Row ${rowIndex}: ${row.cells.length} cells`);
                            if (rowIndex === 0) {
                                const cellDump = row.cells
                                    .map((cell, idx) => {
                                        const text = getTextWithNewlines(cell.layout.textAnchor, rawText).replace(/\n/g, '\\n');
                                        return `Cell[${idx}]: "${text}"`;
                                    })
                                    .join(' ');
                                console.log(`[DEBUG] Table ${tableIndex} Row ${rowIndex} ${cellDump}`);
                            }
                            // [/TEMP DEBUG]

                            row.cells.forEach((cell, cellIndex) => {
                                let cellText = getTextWithNewlines(cell.layout.textAnchor, rawText);

                                // Process only the detected Name/ID column
                                if (cellIndex === nameColumnIndex) {
                                    const parsed = this.parseNameIdCell(cellText);
                                    if (parsed.name && !rowName) rowName = parsed.name;
                                    cellText = parsed.formattedCell;
                                } else {
                                    cellText = cellText.replace(/\n/g, ' '); // Flatten standard cells
                                }

                                rowData.push(cellText);
                            });

                            parsedTable.push(rowData.join(' | '));
                            extractedNamesPerRow.push(rowName);
                        });
                    }
                    tables.push(...parsedTable);
                });
            }
        });
    }

    // Captured before the fallback branch below can populate `tables`, so this
    // reflects which path actually ran (used to decide how to compact
    // orderedPatientNames further down).
    const usedTablePath = tables.length > 0;

    // Fallback if no tables detected (could be a bad image or not a table)
    if (tables.length === 0) {
        console.warn("Document AI found no tables in the image. Falling back to line-by-line.");
        const nonBlankLines = rawText.split('\n').filter(l => l.trim() !== '');

        // PHI masking gap fix: without this, extractedNamesPerRow stays empty on
        // this path, so gemini.js maskPHI() never strips the patient's name out of
        // the raw text before it goes to the LLM (and `name` never gets populated
        // on the output either). Index MUST match each line's position in
        // nonBlankLines, since that's the exact same array pushed into `tables`
        // below — maskPHI() masks rawRows[i] using extractedNamesPerRow[i].
        nonBlankLines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (NAME_PREFIX_PATTERN.test(trimmed)) {
                extractedNamesPerRow[idx] = trimmed;
            }
        });

        tables.push(...nonBlankLines);
    }

    // Since Document AI Form Parser table cells don't reliably have cell-level confidence
    // We use the page-level confidence or a default heuristic.
    // Document AI pages have a `page.layout.confidence` property.
    if (document.pages) {
        document.pages.forEach(page => {
            if (page.layout && page.layout.confidence) {
                totalConfidence += page.layout.confidence;
                cellCount++;
            }
        });
    }
    const averageConfidence = cellCount > 0 ? totalConfidence / cellCount : 0.8; // default to 0.8 if missing

    // Table path: extractedNamesPerRow is 1-position-per-case — remapData() reads
    // extractedNames[i] where i is Gemini's case index, which must line up with
    // row i exactly. Compacting with filter(Boolean) would silently shift every
    // name after a nameless row into the wrong case (no validation would catch
    // it, since finalData.name would just be non-empty but wrong). So keep the
    // array dense (same length, nulls become '') instead of compacting it.
    //
    // Fallback path: there was never a natural 1:1 line-to-case mapping to begin
    // with (see the block above) — it's already a best-effort ordered guess, so
    // compacting to just the names actually found is correct here.
    const orderedPatientNames = usedTablePath
      ? extractedNamesPerRow.map((n) => n || '')
      : extractedNamesPerRow.filter(Boolean);

    return {
      rawRows: tables,
      confidence: averageConfidence,
      extractedNamesPerRow,
      orderedPatientNames,
    };
  }

  /**
   * Scans every line of the full-page OCR text for lines that look like a
   * patient name (matched by a leading Thai honorific: นาย/นาง/นางสาว/ด.ช./ด.ญ.).
   * Used only on the no-table fallback path (see analyzeImage) where Document AI
   * gives back flat page text with no column/row structure to key off of.
   * Returns the matched name lines (honorific included), in the order they
   * appear on the page.
   * @param {string} rawText
   * @returns {string[]}
   */
  extractPatientNamesFromRawText(rawText) {
    if (!rawText) return [];
    return rawText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l !== '' && NAME_PREFIX_PATTERN.test(l));
  }

  /**
   * Parses the multi-line Name/ID cell by matching each line against known patterns
   * (HN/AN, Age/Admitdate, Room, 13-digit ID card), independent of line position.
   * Different staff write this cell in different orders (e.g. HN/AN before the name,
   * or after), and some separate items with "/" or "|" on one physical line instead
   * of real line breaks — so position-based parsing (e.g. "line 1 = name") is
   * unreliable. The first line that doesn't match any known pattern is taken as the
   * name; if no such line exists, name stays null rather than guessing.
   * @param {string} cellText
   * @returns {{ name: string|null, formattedCell: string }}
   */
  parseNameIdCell(cellText) {
    if (!cellText) return { name: null, formattedCell: cellText };

    const lines = cellText
        .split(/[\n/|]/)
        .map(l => l.trim())
        .filter(l => l !== '');
    if (lines.length === 0) return { name: null, formattedCell: cellText };

    const HN_AN_PATTERN = /\bHN\b|\bAN\b|\bH\.N\.?\b|\bA\.N\.?\b/i;
    const AGE_ADMIT_PATTERN = /\bAge\b|\bAdmitdate\b|\bAdmit\b|อายุ/i;
    const ROOM_PATTERN = /\broom\b/i;
    const ID_CARD_PATTERN = /^\d{13}$|^\d{1}-\d{4}-\d{5}-\d{2}-\d{1}$/;

    let name = null;
    const formattedLines = [];

    lines.forEach((line) => {
        if (HN_AN_PATTERN.test(line)) {
            formattedLines.push(line);
        } else if (AGE_ADMIT_PATTERN.test(line) || ROOM_PATTERN.test(line)) {
            formattedLines.push(`Ignored: ${line}`);
        } else if (ID_CARD_PATTERN.test(line)) {
            formattedLines.push(`IDCard: ${line}`);
        } else if (!name) {
            // First unrecognized line = the name (keeps titles like นาย/นาง, per
            // the existing convention of storing name with its honorific intact).
            name = line.replace(/^(ชื่อ|Name)\s*[:.-]?\s*/i, '').trim();
            formattedLines.push(`Name: ${name}`);
        } else {
            // A second unrecognized line after the name was already found — keep
            // it in the formatted cell as-is rather than silently dropping it.
            formattedLines.push(line);
        }
    });

    return { name, formattedCell: formattedLines.join(' | ') };
  }
}

module.exports = new VisionService();
