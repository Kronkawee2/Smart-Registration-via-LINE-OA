const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

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
      return { rawRows: [], confidence: 0, extractedNamesPerRow: [] };
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

    if (document.pages) {
        document.pages.forEach(page => {
            if (page.tables) {
                page.tables.forEach(table => {
                    const parsedTable = [];
                    // Find Name/ID column index from headerRows
                    let nameColumnIndex = 3; // Fallback index
                    let headerFound = false;
                    
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
                        table.bodyRows.forEach(row => {
                            const rowData = [];
                            let rowName = null;
                            
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

    // Fallback if no tables detected (could be a bad image or not a table)
    if (tables.length === 0) {
        console.warn("Document AI found no tables in the image. Falling back to line-by-line.");
        tables.push(...rawText.split('\n').filter(l => l.trim() !== ''));
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

    // Note: fallback arrays won't have matching extractedNames if tables == 0, 
    // but the array length matching is handled by gemini.js fallback.

    return {
      rawRows: tables,
      confidence: averageConfidence,
      extractedNamesPerRow,
    };
  }

  /**
   * Explicitly parses the multi-line Name/ID cell to prevent regex bleeding.
   * Assumes: Line 1 = Name, Lines with HN/AN = HN/AN, 13-digit line = ID Card.
   * @param {string} cellText 
   * @returns {{ name: string|null, formattedCell: string }}
   */
  parseNameIdCell(cellText) {
    const lines = cellText.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (lines.length === 0) return { name: null, formattedCell: cellText };

    let name = null;
    const formattedLines = [];

    lines.forEach((line, index) => {
        // Line 0 is the Name
        if (index === 0) {
            // Remove "ชื่อ" or "Name" prefix if present, but KEEP titles like นาย/นาง
            name = line.replace(/^(ชื่อ|Name)\s*[:.-]?\s*/i, '').trim();
            // Remove trailing numbers or HN just in case they snuck onto line 1
            name = name.replace(/\s*(HN|AN|Room|อายุ|\d).*$/i, '').trim();
            formattedLines.push(`Name: ${name}`);
        } else if (line.match(/HN|AN/i)) {
            // Contains HN or AN
            formattedLines.push(line);
        } else if (line.match(/^\d{13}$/) || line.match(/^\d{1}-\d{4}-\d{5}-\d{2}-\d{1}$/)) {
            // ID Card
            formattedLines.push(`IDCard: ${line}`);
        } else if (line.match(/อายุ|Room|Admit/i)) {
            // Ignored fields
            formattedLines.push(`Ignored: ${line}`);
        } else {
            formattedLines.push(line);
        }
    });

    return { name, formattedCell: formattedLines.join(' | ') };
  }
}

module.exports = new VisionService();
