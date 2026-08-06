const googleSheets = require('./googleSheets');

class DashboardService {
  /**
   * Retrieves summary data with stale cache validation.
   * @param {'today' | 'this_month'} period 
   */
  async getSummary(period) {
    const cache = await googleSheets.getSummaryCache(period);
    
    if (!cache) {
      return this.getEmptySummary();
    }

    const isStale = this.isCacheStale(cache.lastUpdated, period);

    if (isStale) {
      return this.getEmptySummary();
    }

    return cache;
  }

  isCacheStale(lastUpdatedIso, period) {
    if (!lastUpdatedIso) return true;
    
    const lastUpdated = new Date(lastUpdatedIso);
    const now = new Date();

    if (period === 'today') {
      // Validate Exact Date Match
      return (
        lastUpdated.getFullYear() !== now.getFullYear() ||
        lastUpdated.getMonth() !== now.getMonth() ||
        lastUpdated.getDate() !== now.getDate()
      );
    } else if (period === 'this_month') {
      // Validate Month and Year Match Only
      return (
        lastUpdated.getFullYear() !== now.getFullYear() ||
        lastUpdated.getMonth() !== now.getMonth()
      );
    }

    return true;
  }

  getEmptySummary() {
    return {
      lastUpdated: new Date().toISOString(),
      totalCases: 0,
      complicationCount: 0,
      avgTimeMins: 0,
      topEquipments: [], // Empty state
    };
  }

  /**
   * Helper to format data into a LINE Flex Message Carousel
   */
  generateFlexMessage(period, data) {
    const periodText = period === 'today' ? 'วันนี้' : 'เดือนนี้';
    
    // Create equipment text
    let eqText = 'ไม่มีข้อมูลการใช้อุปกรณ์';
    if (data.topEquipments && data.topEquipments.length > 0) {
      eqText = data.topEquipments.map((eq, i) => `${i + 1}. ${eq.name} (${eq.count})`).join('\\n');
    }

    return {
      type: 'flex',
      altText: `สรุปยอดเคส${periodText}: ${data.totalCases} เคส`,
      contents: {
        type: 'carousel',
        contents: [
          {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: `สรุปยอดเคส${periodText}`, weight: 'bold', size: 'xl' },
                { type: 'text', text: `จำนวนเคสทั้งหมด: ${data.totalCases}`, margin: 'md' },
                { type: 'text', text: `มีภาวะแทรกซ้อน: ${data.complicationCount}` },
                { type: 'text', text: `เวลาเฉลี่ย/เคส: ${data.avgTimeMins} นาที` },
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
