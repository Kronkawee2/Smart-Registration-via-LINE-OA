/**
 * Parses equipment input strings from the LIFF UI into structured { new, re } counts.
 */
class EquipmentParser {
    constructor() {
        this.GROUP_A = ['sheath4701', 'balloon4303', 'stent4305'];
        this.GROUP_B = ['guideWire4711', 'dxCath4407', 'guiding4301', 'ptcaWire4302'];
    }

    /**
     * Parses a single equipment input string into { new, re }.
     * @param {string} input - The string entered by the user (e.g., '1', '2', '1+1', '2+1')
     * @param {string} fieldName - The name of the equipment field to validate Group A vs Group B
     * @returns {{ new: number, re: number }}
     */
    parseInput(input, fieldName) {
        if (!input || input.trim() === '') return { new: 0, re: 0 };
        
        input = input.trim();
        
        // Group A Validation: Must be a single number (no '+')
        if (this.GROUP_A.includes(fieldName)) {
            if (!/^\d+$/.test(input)) {
                throw new Error(`Field ${fieldName} only allows new items (no '+'). Received: ${input}`);
            }
            return { new: parseInt(input, 10), re: 0 };
        }
        
        // Group B Validation: Can be single number or number+number
        if (this.GROUP_B.includes(fieldName)) {
            if (!/^\d+$|^\d+\+\d+$/.test(input)) {
                throw new Error(`Field ${fieldName} has invalid format. Received: ${input}`);
            }
            
            if (input.includes('+')) {
                const parts = input.split('+');
                return { new: parseInt(parts[0], 10), re: parseInt(parts[1], 10) };
            } else {
                return { new: parseInt(input, 10), re: 0 };
            }
        }

        // Pass-through for fields not in A or B (like generator, lead)
        if (!/^\d+$/.test(input)) {
            throw new Error(`Field ${fieldName} must be a number (no '+'). Received: ${input}`);
        }
        return { new: parseInt(input, 10), re: 0 };
    }

    /**
     * Parses the 'Other' input string.
     * Format: "4316*1,4319*1R" -> [{ code: '4316', qty: 1, isRe: false }, { code: '4319', qty: 1, isRe: true }]
     * @param {string} input
     * @returns {Array<{code: string, qty: number, isRe: boolean}>}
     */
    parseOther(input) {
        if (!input || input.trim() === '') return [];
        
        const items = input.split(',').map(item => item.trim());
        const parsedItems = [];
        
        for (const item of items) {
            // Match format: CODE*QTY or CODE*QTY+R
            const match = item.match(/^([a-zA-Z0-9]+)\*(\d+)(R)?$/i);
            if (!match) {
                throw new Error(`Invalid format for Other: '${item}'`);
            }
            parsedItems.push({
                code: match[1],
                qty: parseInt(match[2], 10),
                isRe: !!match[3]
            });
        }
        
        return parsedItems;
    }
}

module.exports = new EquipmentParser();
