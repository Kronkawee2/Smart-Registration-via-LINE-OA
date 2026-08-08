const googleSheets = require('./googleSheets');

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// Thai month name + Buddhist Era year, e.g. "สิงหาคม 2569", matching the
// convention used in the source notebook.
function getCurrentThaiMonthYear() {
  const now = new Date();
  return `${THAI_MONTHS[now.getMonth()]} ${now.getFullYear() + 543}`;
}

class DashboardService {
  /**
   * Retrieves the current month's summary with stale cache validation.
   */
  async getSummary() {
    const cache = await googleSheets.getSummaryCache();

    if (!cache) {
      return this.getEmptySummary();
    }

    if (this.isCacheStale(cache.lastUpdated)) {
      return this.getEmptySummary();
    }

    return cache;
  }

  isCacheStale(lastUpdatedIso) {
    if (!lastUpdatedIso) return true;

    const lastUpdated = new Date(lastUpdatedIso);
    const now = new Date();

    return (
      lastUpdated.getFullYear() !== now.getFullYear() ||
      lastUpdated.getMonth() !== now.getMonth()
    );
  }

  getEmptySummary() {
    return {
      lastUpdated: new Date().toISOString(),
      totalCases: 0,
      cagCount: 0,
      cagPciCount: 0,
      topEquipments: [],
    };
  }

  /**
   * Formats the current month's summary into a LINE Flex Message.
   */
  generateFlexMessage(data) {
    let eqText = 'ไม่มีข้อมูลการใช้อุปกรณ์';
    if (data.topEquipments && data.topEquipments.length > 0) {
      eqText = data.topEquipments.map((eq, i) => `${i + 1}. ${eq.name} (${eq.count})`).join('\\n');
    }

    return {
      type: 'flex',
      altText: `สรุปยอดเคสเดือนนี้: ${data.totalCases} เคส`,
      contents: {
        type: 'carousel',
        contents: [
          {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: `สรุปยอดเคส ${getCurrentThaiMonthYear()}`, weight: 'bold', size: 'xl' },
                { type: 'text', text: `จำนวนเคสทั้งหมด: ${data.totalCases}`, margin: 'md' },
                { type: 'text', text: `CAG: ${data.cagCount} เคส` },
                { type: 'text', text: `CAG+PCI: ${data.cagPciCount} เคส` },
              ]
            }
          },
          {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: 'Top อุปกรณ์ (3 อันดับ)', weight: 'bold', size: 'xl' },
                { type: 'text', text: eqText, margin: 'md', wrap: true }
              ]
            }
          }
        ]
      }
    };
  }
}

module.exports = new DashboardService();