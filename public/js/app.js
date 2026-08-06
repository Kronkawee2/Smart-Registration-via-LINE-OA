// ============ Field Definitions ============

// Fields AI extracts from the notebook photo — technician reviews & corrects them.
const GENERAL_FIELDS = [
    { id: 'name', label: 'ชื่อ-นามสกุล', type: 'text', placeholder: 'เช่น นายสมชาย ใจดี' },
    { id: 'ccn', label: 'CCN', type: 'text', placeholder: 'เช่น 26-0001' },
    { id: 'hn', label: 'HN', type: 'text', placeholder: 'เลขประจำตัวผู้ป่วย' },
    { id: 'an', label: 'AN', type: 'text', placeholder: 'เลขที่รับการรักษา' },
    { id: 'age', label: 'อายุ', type: 'text', placeholder: 'เช่น 65' },
    { id: 'payment', label: 'สิทธิการรักษา (Payment)', type: 'text', placeholder: 'เช่น สปสช./ประกันสังคม/เบิกได้' },
    { id: 'hospital', label: 'โรงพยาบาล', type: 'text', placeholder: 'เช่น รพ.xxx' },
    { id: 'date', label: 'วันที่', type: 'date' },
    { id: 'timeIn', label: 'เวลาเริ่ม (Time in)', type: 'time' },
    { id: 'timeOut', label: 'เวลาสิ้นสุด (Time out)', type: 'time' }
];

// Suggested names for the datalist — technician can pick or type a new name freely.
const DOCTOR_SUGGESTIONS = ['นพ.สมชาย เก่งกล้า', 'นพ.วิชัย มั่นคง', 'พญ.สุดา แสงทอง'];
const STAFF_SUGGESTIONS = ['คุณสมหญิง ใจเย็น', 'คุณอนุชา ตั้งใจ', 'คุณปิยะ ขยัน', 'คุณนภา รอบคอบ'];

const STAFF_FIELDS = [
    { id: 'doctor', label: 'Doctor', suggestions: DOCTOR_SUGGESTIONS },
    { id: 'scrub', label: 'Scrub', suggestions: STAFF_SUGGESTIONS },
    { id: 'circulate', label: 'Circulate', suggestions: STAFF_SUGGESTIONS },
    { id: 'monitor', label: 'Monitor', suggestions: STAFF_SUGGESTIONS }
];

const TREATMENT_FIELDS = [
    { id: 'indication', label: 'Indication', type: 'textarea' },
    { id: 'procedure', label: 'Procedure', type: 'textarea' },
    { id: 'result', label: 'Result', type: 'textarea' },
    { id: 'punctureSite', label: 'Puncture site', type: 'text', placeholder: 'เช่น Right femoral' },
    { id: 'complication', label: 'Complication', type: 'textarea', placeholder: 'ไม่มี / ระบุ' },
    { id: 'recommendation', label: 'Recommendation', type: 'textarea' }
];

// Fields the technician fills manually via number-style inputs (never AI-filled, to keep stock counts accurate).
const GROUP_A = [
    { id: 'sheath4701', label: 'Sheath (4701)', placeholder: 'เช่น 1' },
    { id: 'balloon4303', label: 'Balloon (4303)', placeholder: 'เช่น 2' },
    { id: 'stent4305', label: 'Stent (4305)', placeholder: 'เช่น 1' }
];

const GROUP_B = [
    { id: 'guideWire4711', label: 'Guide wire (4711)', placeholder: 'เช่น 1 หรือ 1+1' },
    { id: 'dxCath4407', label: 'Dx. Cath (4407)', placeholder: 'เช่น 1 หรือ 1+1' },
    { id: 'guiding4301', label: 'Guiding (4301)', placeholder: 'เช่น 1 หรือ 1+1' },
    { id: 'ptcaWire4302', label: 'PTCA wire (4302)', placeholder: 'เช่น 1 หรือ 1+1' }
];

const OTHER_FIELDS = [
    { id: 'generator', label: 'Generator', placeholder: 'เช่น 1' },
    { id: 'lead', label: 'Lead', placeholder: 'เช่น 1' },
    { id: 'other', label: 'Other', placeholder: 'เช่น 4316*1,4319*1R' }
];

// ============ Global State ============
// Mocking for now since we don't have a GET endpoint yet.
// In production, this would be fetched via `await fetch('/api/log/' + logId)`
let currentCases = [
    {
        no: '1', ccn: '26-0001', name: 'นายสมชาย ใจดี', hn: '12345678', an: '87654321',
        age: '65', payment: 'สปสช.', hospital: 'รพ.xxx',
        date: '2026-08-05', timeIn: '09:15', timeOut: '10:40',
        doctor: 'นพ.สมชาย เก่งกล้า', scrub: 'คุณสมหญิง ใจเย็น', circulate: 'คุณอนุชา ตั้งใจ', monitor: 'คุณปิยะ ขยัน',
        indication: 'CAD with unstable angina', procedure: 'CAG+PCI to LAD',
        result: 'Successful PCI, TIMI III flow', punctureSite: 'Right radial',
        complication: 'ไม่มี', recommendation: 'DAPT 1 ปี, F/U 1 เดือน'
    },
    {
        no: '2', ccn: '26-0002', name: 'นางสาววิไล รักษา', hn: '99887766', an: '11223344',
        age: '72', payment: 'ประกันสังคม', hospital: 'รพ.xxx',
        date: '2026-08-05', timeIn: '11:00', timeOut: '12:20',
        doctor: 'นพ.วิชัย มั่นคง', scrub: 'คุณนภา รอบคอบ', circulate: 'คุณสมหญิง ใจเย็น', monitor: 'คุณอนุชา ตั้งใจ',
        indication: 'Complete heart block', procedure: 'PPI (Dual chamber)',
        result: 'Successful implantation, threshold ปกติ', punctureSite: 'Left subclavian',
        complication: 'ไม่มี', recommendation: 'CXR post-op, F/U Pacemaker clinic 1 สัปดาห์'
    }
];

// Per-case editable snapshot (general + staff + treatment fields), keyed by case index.
// Initialized as a clone of the original record so unedited fields still submit correctly.
let editedData = {};
let equipmentData = {};
const savedCcns = new Set();

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const configRes = await fetch('/api/config');
        const { liffId } = await configRes.json();

        await liff.init({ liffId });
        if (liff.isLoggedIn()) {
            const profile = await liff.getProfile();
            document.getElementById('profile-img').style.backgroundImage = `url(${profile.pictureUrl})`;
            document.getElementById('profile-img').classList.remove('hidden');
        }
    } catch (err) {
        console.warn('LIFF init failed (Running locally?)', err);
    }

    // URL Params
    const urlParams = new URLSearchParams(window.location.search);
    const logId = urlParams.get('logId') || 'mock-log-id';

    // Mock fetching data from backend
    // const res = await fetch(`/api/log/${logId}`);
    // currentCases = await res.json();

    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('header-status').textContent = 'กรุณาตรวจสอบข้อมูลและกรอกอุปกรณ์';

    renderCases();
    document.getElementById('bottom-bar').classList.remove('hidden');
});

function renderCases() {
    const container = document.getElementById('cases-container');
    const template = document.getElementById('case-template').content;
    container.innerHTML = '';

    currentCases.forEach((caseData, index) => {
        // Initialize per-case editable state
        equipmentData[index] = {};
        editedData[index] = { ...caseData };

        const clone = document.importNode(template, true);

        const headerTitleEl = clone.querySelector('.case-header-title');
        const headerCcnEl = clone.querySelector('.case-ccn');
        headerTitleEl.textContent = `เคสที่ ${caseData.no} — ${caseData.name}`;
        headerCcnEl.textContent = caseData.ccn;

        // ---- General Info (editable) ----
        const generalForm = clone.querySelector('.general-form');
        GENERAL_FIELDS.forEach(field => {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <label class="block text-xs font-medium text-neutral-400">${field.label}</label>
                <input type="${field.type}" id="gen-${index}-${field.id}" data-id="${field.id}"
                    value="${escapeAttr(caseData[field.id] || '')}" placeholder="${field.placeholder || ''}"
                    class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
            `;
            generalForm.appendChild(wrapper);

            const inputEl = wrapper.querySelector('input');
            inputEl.addEventListener('input', (e) => {
                editedData[index][field.id] = e.target.value.trim();
                // Keep the card header in sync when name/CCN get corrected
                if (field.id === 'name') {
                    headerTitleEl.textContent = `เคสที่ ${caseData.no} — ${editedData[index].name || '-'}`;
                }
                if (field.id === 'ccn') {
                    headerCcnEl.textContent = editedData[index].ccn || '-';
                }
            });
        });

        // ---- Staff (dropdown suggestions + free text) ----
        const staffForm = clone.querySelector('.staff-form');
        STAFF_FIELDS.forEach(field => {
            const listId = `staff-list-${index}-${field.id}`;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <label class="block text-xs font-medium text-neutral-400">${field.label}</label>
                <input type="text" id="staff-${index}-${field.id}" data-id="${field.id}" list="${listId}"
                    value="${escapeAttr(caseData[field.id] || '')}" placeholder="เลือกหรือพิมพ์ชื่อ"
                    class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                <datalist id="${listId}">
                    ${field.suggestions.map(name => `<option value="${escapeAttr(name)}"></option>`).join('')}
                </datalist>
            `;
            staffForm.appendChild(wrapper);

            const inputEl = wrapper.querySelector('input');
            inputEl.addEventListener('input', (e) => {
                editedData[index][field.id] = e.target.value.trim();
            });
        });

        // ---- Treatment Details (editable) ----
        const treatmentForm = clone.querySelector('.treatment-form');
        TREATMENT_FIELDS.forEach(field => {
            const wrapper = document.createElement('div');
            const isTextarea = field.type === 'textarea';
            wrapper.innerHTML = `
                <label class="block text-xs font-medium text-neutral-400">${field.label}</label>
                ${isTextarea
                    ? `<textarea id="tx-${index}-${field.id}" data-id="${field.id}" rows="2" placeholder="${field.placeholder || ''}"
                        class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500 resize-y">${escapeHtml(caseData[field.id] || '')}</textarea>`
                    : `<input type="text" id="tx-${index}-${field.id}" data-id="${field.id}" value="${escapeAttr(caseData[field.id] || '')}" placeholder="${field.placeholder || ''}"
                        class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />`
                }
            `;
            treatmentForm.appendChild(wrapper);

            const fieldEl = wrapper.querySelector(isTextarea ? 'textarea' : 'input');
            fieldEl.addEventListener('input', (e) => {
                editedData[index][field.id] = e.target.value.trim();
            });
        });

        // ---- Equipment (manual entry, unchanged behavior) ----
        const form = clone.querySelector('.equipment-form');

        const renderInput = (item, group) => {
            const wrapper = document.createElement('div');
            if (item.id === 'other') wrapper.className = 'md:col-span-2';

            wrapper.innerHTML = `
                <label class="block text-sm font-medium text-neutral-300">${item.label}</label>
                <input type="text" id="eq-${index}-${item.id}" data-id="${item.id}" data-group="${group}" placeholder="${item.placeholder}"
                    class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                <p id="err-${index}-${item.id}" class="text-red-400 text-xs mt-1 hidden"></p>
            `;
            form.appendChild(wrapper);

            // Add Event Listener for validation
            const inputEl = wrapper.querySelector('input');
            const errEl = wrapper.querySelector('p');

            inputEl.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                equipmentData[index][item.id] = val;
                validateInput(val, group, errEl, inputEl);
            });
        };

        GROUP_A.forEach(item => renderInput(item, 'A'));
        GROUP_B.forEach(item => renderInput(item, 'B'));
        OTHER_FIELDS.forEach(item => renderInput(item, 'OTHER'));

        container.appendChild(clone);
    });

    container.classList.remove('hidden');
}

function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function validateInput(value, group, errEl, inputEl) {
    if (value === '') {
        errEl.classList.add('hidden');
        inputEl.classList.remove('border-red-500');
        inputEl.classList.add('border-neutral-600');
        return true;
    }

    let isValid = true;
    let errorMsg = '';

    if (group === 'A' && !/^\d+$/.test(value)) {
        isValid = false;
        errorMsg = "กรอกเฉพาะตัวเลข (ห้ามใช้ '+')";
    } else if (group === 'B' && !/^\d+$|^\d+\+\d+$/.test(value)) {
        isValid = false;
        errorMsg = "รูปแบบผิด (ต้องเป็นเลขเดี่ยว หรือ N+M)";
    } else if (group === 'OTHER' && inputEl.id.includes('other') && !/^([a-zA-Z0-9]+\*\d+(R)?)(,[a-zA-Z0-9]+\*\d+(R)?)*$/i.test(value)) {
        isValid = false;
        errorMsg = "รูปแบบผิด (เช่น '4316*1' หรือ '4316*1R,4319*2')";
    }

    if (!isValid) {
        errEl.textContent = errorMsg;
        errEl.classList.remove('hidden');
        inputEl.classList.add('border-red-500');
        inputEl.classList.remove('border-neutral-600');
    } else {
        errEl.classList.add('hidden');
        inputEl.classList.remove('border-red-500');
        inputEl.classList.add('border-neutral-600');
    }

    return isValid;
}

document.getElementById('btn-submit-all').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก...';

    // Verify all equipment inputs are valid before submitting
    const allInputs = document.querySelectorAll('.equipment-form input');
    let hasError = false;
    allInputs.forEach(input => {
        if (input.classList.contains('border-red-500')) hasError = true;
    });

    if (hasError) {
        alert('กรุณาแก้ไขข้อมูลที่มีสีแดงให้ถูกต้องก่อนบันทึก');
        btn.disabled = false;
        btn.textContent = 'บันทึกข้อมูลทั้งหมดเข้า Sheet';
        return;
    }

    try {
        // Build the array of cases, excluding ones already saved successfully.
        // recordData now comes from editedData, which reflects all field edits
        // (general info, staff, and treatment details), not just the original AI output.
        const logId = new URLSearchParams(window.location.search).get('logId') || 'mock-id';
        const cases = currentCases
            .map((_, index) => ({
                recordData: editedData[index],
                equipmentData: equipmentData[index] || {},
                aiJsonOutput: {}
            }))
            .filter((c) => !savedCcns.has(c.recordData.ccn));

        if (cases.length === 0) {
            alert('ทุกเคสบันทึกสำเร็จแล้ว ไม่มีข้อมูลที่ต้องส่งเพิ่ม');
            btn.disabled = false;
            btn.textContent = 'บันทึกข้อมูลทั้งหมดเข้า Sheet';
            return;
        }

        const payload = { logId, cases };

        // Get LIFF ID Token if logged in
        let token = 'dummy_token';
        if (typeof liff !== 'undefined' && liff.isLoggedIn()) {
            token = liff.getIDToken();
        }

        const res = await fetch('/api/submit-liff', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        const result = await res.json();

        // Handle Partial Failures in UI
        if (result.results && Array.isArray(result.results)) {
            result.results.forEach((resItem) => {
                // Find the card by CCN (matched against the edited/current CCN, since the
                // technician may have corrected it before submitting)
                const caseIndex = currentCases.findIndex((_, idx) => editedData[idx] && editedData[idx].ccn === resItem.ccn);
                if (caseIndex !== -1) {
                    const card = document.querySelectorAll('.case-card')[caseIndex];
                    if (resItem.success) {
                        savedCcns.add(resItem.ccn);

                        card.classList.add('border-green-500');
                        card.classList.remove('border-red-500', 'border-neutral-700');
                        card.querySelector('.status-saved').classList.remove('hidden');
                        card.querySelector('.status-saved').textContent = '✅ บันทึกสำเร็จ';
                        card.querySelector('.status-saved').classList.add('text-green-400');
                        card.querySelector('.status-saved').classList.remove('text-red-400');

                        // Lock all inputs so the tech can't accidentally edit already-saved data
                        card.querySelectorAll('input, textarea').forEach((input) => {
                            input.disabled = true;
                        });
                    } else {
                        card.classList.add('border-red-500');
                        card.classList.remove('border-green-500', 'border-neutral-700');
                        card.querySelector('.status-saved').classList.remove('hidden');
                        card.querySelector('.status-saved').textContent = `❌ ${resItem.message}`;
                        card.querySelector('.status-saved').classList.add('text-red-400');
                        card.querySelector('.status-saved').classList.remove('text-green-400');
                    }
                }
            });

            const allSuccess = currentCases.every((c, idx) => savedCcns.has(editedData[idx].ccn));

            if (allSuccess) {
                alert('บันทึกข้อมูลทุกเคสเรียบร้อย');
                if (typeof liff !== 'undefined' && liff.isLoggedIn()) liff.closeWindow();
            } else {
                alert('บางเคสบันทึกไม่สำเร็จ กรุณาตรวจสอบข้อความสีแดงใต้การ์ด');
            }
        } else if (!result.success) {
            alert('บันทึกไม่สำเร็จ: ' + (result.message || 'Unknown Error'));
        }
    } catch (error) {
        alert('เกิดข้อผิดพลาดในการเชื่อมต่อ');
        console.error(error);
    } finally {
        btn.disabled = false;
        btn.textContent = 'บันทึกข้อมูลทั้งหมดเข้า Sheet';
    }
});