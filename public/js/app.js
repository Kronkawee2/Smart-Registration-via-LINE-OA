// ============ Field Definitions ============

// Suggestion lists for datalists — populated from Google Sheet `Config_Master` via
// GET /api/config-master (see loadConfigMaster()). Kept as `let` arrays and mutated
// in place with .splice() so that GENERAL_FIELDS/STAFF_FIELDS below can hold a stable
// reference to them and pick up the fetched values once loadConfigMaster() resolves,
// even though those field definitions are declared before the fetch happens.
let DOCTOR_SUGGESTIONS = [];
let SCRUB_SUGGESTIONS = [];
let CIRCULATE_SUGGESTIONS = [];
let MONITOR_SUGGESTIONS = [];
let HOSPITAL_SUGGESTIONS = [];
let PAYMENT_SUGGESTIONS = [];

// Fallback values used only if /api/config-master is unreachable (e.g. local dev
// without the backend running) so the form is still usable for testing.
const FALLBACK_SUGGESTIONS = {
    doctors: ['นพ.สมชาย เก่งกล้า', 'นพ.วิชัย มั่นคง', 'พญ.สุดา แสงทอง'],
    scrubs: ['คุณสมหญิง ใจเย็น', 'คุณปิยะ ขยัน'],
    circulates: ['คุณอนุชา ตั้งใจ', 'คุณนภา รอบคอบ'],
    monitors: ['คุณปิยะ ขยัน', 'คุณอนุชา ตั้งใจ'],
    hospitals: ['รพ.xxx'],
    payments: ['UCEP', 'สปสช.', 'ประกันสังคม']
};

// Format validation for AI-extracted identifier fields. Mirrors the pattern used in
// gemini.js remapData() (CCN: NN-NNNN, HN/AN: 8-digit) and the mask-token pattern in
// gemini.js maskPHI() (ID Card: 13-digit). Kept as a lookup so the same rules can be
// reused for the pre-submit block check without duplicating regex.
// `required: false` (idCard only) means an empty value is allowed — not every case
// has a legible ID card in the photo — while CCN/HN/AN stay mandatory as before.
const GENERAL_VALIDATION = {
    no: { pattern: /^\d+$/, message: "ลำดับที่ (No.) ต้องเป็นตัวเลขล้วน" },
    ccn: { pattern: /^\d{2}-\d{4}$/, message: "รูปแบบ CCN ไม่ถูกต้อง (เช่น 26-0001)" },
    hn: { pattern: /^\d{8}$/, message: "HN ต้องเป็นตัวเลข 8 หลัก" },
    an: { pattern: /^\d{8}$/, message: "AN ต้องเป็นตัวเลข 8 หลัก" },
    idCard: { pattern: /^\d{13}$/, message: "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก", required: false }
};

// Fields AI extracts from the notebook photo — technician reviews & corrects them.
// `suggestions` (optional) hooks the field up to a <datalist> fed by Config_Master.
// `no` (running case number from the notebook's "No." column) is first — handwritten
// digits like "6" vs "2" are occasionally misread by OCR, so this needs to be an
// easy, obvious first fix for the technician reviewing the case.
const GENERAL_FIELDS = [
    { id: 'no', label: 'ลำดับที่ (No.)', type: 'text', placeholder: 'เช่น 6' },
    { id: 'name', label: 'ชื่อ-นามสกุล', type: 'text', placeholder: 'เช่น นายสมชาย ใจดี' },
    { id: 'ccn', label: 'CCN', type: 'text', placeholder: 'เช่น 26-0001' },
    { id: 'hn', label: 'HN', type: 'text', placeholder: 'เลขประจำตัวผู้ป่วย' },
    { id: 'an', label: 'AN', type: 'text', placeholder: 'เลขที่รับการรักษา' },
    { id: 'idCard', label: 'เลขบัตรประชาชน', type: 'text', placeholder: 'ตัวเลข 13 หลัก (ถ้ามี)' },
    { id: 'age', label: 'อายุ', type: 'text', placeholder: 'เช่น 65' },
    { id: 'payment', label: 'สิทธิการรักษา (Payment)', type: 'text', placeholder: 'เช่น สปสช./ประกันสังคม/เบิกได้', suggestions: PAYMENT_SUGGESTIONS },
    { id: 'hospital', label: 'โรงพยาบาล', type: 'text', placeholder: 'เช่น รพ.xxx', suggestions: HOSPITAL_SUGGESTIONS },
    { id: 'date', label: 'วันที่', type: 'date' },
    { id: 'timeIn', label: 'เวลาเริ่ม (Time in)', type: 'time' },
    { id: 'timeOut', label: 'เวลาสิ้นสุด (Time out)', type: 'time' }
];

const STAFF_FIELDS = [
    { id: 'doctor', label: 'Doctor', suggestions: DOCTOR_SUGGESTIONS },
    { id: 'scrub', label: 'Scrub', suggestions: SCRUB_SUGGESTIONS },
    // Circulate/Monitor can have multiple people on one case (up to 5 / up to 3),
    // comma-separated in one cell (same as gemini.js extracts). No `suggestions` —
    // a datalist can only autocomplete a single name, which isn't useful here, so
    // these two are plain free-text inputs.
    { id: 'circulate', label: 'Circulate', placeholder: 'พิมพ์ชื่อ (ใส่ได้หลายคน คั่นด้วยลูกน้ำ)' },
    // Config_Master does have a dedicated "Monitor" column (see MONITOR_SUGGESTIONS /
    // loadConfigMaster below), but it's still not wired up as a dropdown here — same
    // reasoning as circulate above, a datalist only autocompletes one name at a time.
    { id: 'monitor', label: 'Monitor', placeholder: 'พิมพ์ชื่อ (ใส่ได้หลายคน คั่นด้วยลูกน้ำ)' }
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

// Rendered as two separate New/Re number inputs (see renderGroupBInput), then combined
// client-side into the same "New" or "New+Re" string the backend has always expected —
// equipmentParser.js and index.js are untouched.
const GROUP_B = [
    { id: 'guideWire4711', label: 'Guide wire (4711)' },
    { id: 'dxCath4407', label: 'Dx. Cath (4407)' },
    { id: 'guiding4301', label: 'Guiding (4301)' },
    { id: 'ptcaWire4302', label: 'PTCA wire (4302)' }
];

const OTHER_FIELDS = [
    { id: 'generator', label: 'Generator', placeholder: 'เช่น 1' },
    { id: 'lead', label: 'Lead', placeholder: 'เช่น 1' },
    { id: 'other', label: 'Other', placeholder: 'เช่น 4316*1,4319*1R' }
];

// ============ Global State ============
// Populated by fetching GET /api/log/:logId in the DOMContentLoaded handler below.
let currentCases = [];

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

    // Load Doctor/Scrub/Circulate/Hospital suggestions from Google Sheet Config_Master
    // before rendering, so the datalists are populated on first paint.
    await loadConfigMaster();

    // URL Params
    const urlParams = new URLSearchParams(window.location.search);
    const logId = urlParams.get('logId') || 'mock-log-id';

    try {
        // /api/log/:logId returns real PHI, so it requires the same LIFF ID token
        // auth as /api/submit-liff (see verifyLiffAuth() server-side).
        let token = 'dummy_token';
        if (typeof liff !== 'undefined' && liff.isLoggedIn()) {
            token = liff.getIDToken();
        }

        const res = await fetch(`/api/log/${logId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`/api/log/${logId} returned ${res.status}`);
        currentCases = await res.json();
    } catch (err) {
        console.error('Failed to load case data', err);
        currentCases = [];
    }

    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('header-status').textContent = 'กรุณาตรวจสอบข้อมูลและกรอกอุปกรณ์';

    renderCases();
    document.getElementById('bottom-bar').classList.remove('hidden');
});

// Fetches Doctors/Scrubs/Circulates/Monitor/Hospitals/Payment from GET /api/config-master
// (reads the `Config_Master` tab of the Google Sheet server-side). This is read-only,
// non-PHI reference data, so it's fetched anonymously — no Authorization header is sent,
// matching the same reasoning as other read-only lookup endpoints in this app.
// Falls back to a small built-in list if the endpoint isn't reachable, so the LIFF
// page still works for local/offline testing.
async function loadConfigMaster() {
    try {
        const res = await fetch('/api/config-master');
        if (!res.ok) throw new Error(`config-master returned ${res.status}`);
        const data = await res.json();

        if (Array.isArray(data.doctors)) DOCTOR_SUGGESTIONS.splice(0, DOCTOR_SUGGESTIONS.length, ...data.doctors);
        if (Array.isArray(data.scrubs)) SCRUB_SUGGESTIONS.splice(0, SCRUB_SUGGESTIONS.length, ...data.scrubs);
        if (Array.isArray(data.circulates)) CIRCULATE_SUGGESTIONS.splice(0, CIRCULATE_SUGGESTIONS.length, ...data.circulates);
        if (Array.isArray(data.monitors)) MONITOR_SUGGESTIONS.splice(0, MONITOR_SUGGESTIONS.length, ...data.monitors);
        if (Array.isArray(data.hospitals)) HOSPITAL_SUGGESTIONS.splice(0, HOSPITAL_SUGGESTIONS.length, ...data.hospitals);
        if (Array.isArray(data.payments)) PAYMENT_SUGGESTIONS.splice(0, PAYMENT_SUGGESTIONS.length, ...data.payments);
    } catch (err) {
        console.warn('Config_Master fetch failed, using fallback suggestion list', err);
        if (DOCTOR_SUGGESTIONS.length === 0) DOCTOR_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.doctors);
        if (SCRUB_SUGGESTIONS.length === 0) SCRUB_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.scrubs);
        if (CIRCULATE_SUGGESTIONS.length === 0) CIRCULATE_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.circulates);
        if (MONITOR_SUGGESTIONS.length === 0) MONITOR_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.monitors);
        if (HOSPITAL_SUGGESTIONS.length === 0) HOSPITAL_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.hospitals);
        if (PAYMENT_SUGGESTIONS.length === 0) PAYMENT_SUGGESTIONS.push(...FALLBACK_SUGGESTIONS.payments);
    }
}

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

        // ---- General Info (editable, with format validation on CCN/HN/AN) ----
        const generalForm = clone.querySelector('.general-form');
        GENERAL_FIELDS.forEach(field => {
            const hasSuggestions = Array.isArray(field.suggestions);
            const listId = hasSuggestions ? `gen-list-${index}-${field.id}` : '';
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <label class="block text-xs font-medium text-neutral-400">${field.label}</label>
                <input type="${field.type}" id="gen-${index}-${field.id}" data-id="${field.id}"
                    ${hasSuggestions ? `list="${listId}"` : ''}
                    value="${escapeAttr(caseData[field.id] || '')}" placeholder="${field.placeholder || ''}"
                    class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                ${hasSuggestions ? `<datalist id="${listId}">${field.suggestions.map(v => `<option value="${escapeAttr(v)}"></option>`).join('')}</datalist>` : ''}
                <p id="err-gen-${index}-${field.id}" class="text-red-400 text-xs mt-1 hidden"></p>
            `;
            generalForm.appendChild(wrapper);

            const inputEl = wrapper.querySelector('input');
            const errEl = wrapper.querySelector('p');

            const handleChange = (value) => {
                editedData[index][field.id] = value;
                validateGeneralInput(field.id, value, errEl, inputEl);
                // Keep the card header in sync when name/CCN get corrected
                if (field.id === 'name') {
                    headerTitleEl.textContent = `เคสที่ ${caseData.no} — ${editedData[index].name || '-'}`;
                }
                if (field.id === 'ccn') {
                    headerCcnEl.textContent = editedData[index].ccn || '-';
                }
            };

            inputEl.addEventListener('input', (e) => handleChange(e.target.value.trim()));

            // Validate the pre-filled/AI-extracted value immediately, so a bad OCR
            // read on CCN/HN/AN is flagged even before the technician touches it.
            validateGeneralInput(field.id, inputEl.value, errEl, inputEl);
        });

        // ---- Staff (dropdown suggestions from Config_Master + free text) ----
        const staffForm = clone.querySelector('.staff-form');
        STAFF_FIELDS.forEach(field => {
            const hasSuggestions = Array.isArray(field.suggestions);
            const listId = hasSuggestions ? `staff-list-${index}-${field.id}` : '';
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <label class="block text-xs font-medium text-neutral-400">${field.label}</label>
                <input type="text" id="staff-${index}-${field.id}" data-id="${field.id}"
                    ${hasSuggestions ? `list="${listId}"` : ''}
                    value="${escapeAttr(caseData[field.id] || '')}" placeholder="${field.placeholder || 'เลือกหรือพิมพ์ชื่อ'}"
                    class="mt-1 block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                ${hasSuggestions ? `<datalist id="${listId}">${field.suggestions.map(name => `<option value="${escapeAttr(name)}"></option>`).join('')}</datalist>` : ''}
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

        // Group B renders as two explicit inputs (New / Re) so technicians don't have
        // to remember the "1+1" typed-string convention. Combined into the same
        // New/Re string format on every keystroke and stored under the same
        // equipmentData[index][item.id] key the backend has always read.
        const renderGroupBInput = (item) => {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <label class="block text-sm font-medium text-neutral-300">${item.label}</label>
                <div class="mt-1 grid grid-cols-2 gap-2">
                    <div>
                        <label class="block text-xs text-neutral-400 mb-1">ใหม่ (New)</label>
                        <input type="text" id="eq-${index}-${item.id}-new" data-id="${item.id}" data-part="new" placeholder="0"
                            class="block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                        <p id="err-${index}-${item.id}-new" class="text-red-400 text-xs mt-1 hidden"></p>
                    </div>
                    <div>
                        <label class="block text-xs text-neutral-400 mb-1">Re</label>
                        <input type="text" id="eq-${index}-${item.id}-re" data-id="${item.id}" data-part="re" placeholder="0"
                            class="block w-full rounded-md border border-neutral-600 bg-neutral-700 text-neutral-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 outline-none transition-colors placeholder-neutral-500" />
                        <p id="err-${index}-${item.id}-re" class="text-red-400 text-xs mt-1 hidden"></p>
                    </div>
                </div>
            `;
            form.appendChild(wrapper);

            const newInput = wrapper.querySelector(`#eq-${index}-${item.id}-new`);
            const reInput = wrapper.querySelector(`#eq-${index}-${item.id}-re`);
            const newErr = wrapper.querySelector(`#err-${index}-${item.id}-new`);
            const reErr = wrapper.querySelector(`#err-${index}-${item.id}-re`);

            const combineAndStore = () => {
                const newVal = newInput.value.trim();
                const reVal = reInput.value.trim();
                const reNum = parseInt(reVal, 10);

                let combined;
                if (!reVal || isNaN(reNum) || reNum <= 0) {
                    combined = newVal;
                } else {
                    combined = `${newVal || '0'}+${reVal}`;
                }
                equipmentData[index][item.id] = combined;
            };

            newInput.addEventListener('input', (e) => {
                validateInput(e.target.value.trim(), 'A', newErr, newInput);
                combineAndStore();
            });
            reInput.addEventListener('input', (e) => {
                validateInput(e.target.value.trim(), 'A', reErr, reInput);
                combineAndStore();
            });
        };

        GROUP_A.forEach(item => renderInput(item, 'A'));
        GROUP_B.forEach(item => renderGroupBInput(item));
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

// Validates CCN/HN/AN/idCard against the same formats used server-side in gemini.js
// (CCN: NN-NNNN, HN/AN: 8-digit, idCard: 13-digit mask-token pattern). Fields not
// listed in GENERAL_VALIDATION (name, age, payment, hospital, date, timeIn, timeOut)
// have no format restriction and always pass.
function validateGeneralInput(fieldId, value, errEl, inputEl) {
    const rule = GENERAL_VALIDATION[fieldId];
    if (!rule) return true;

    // CCN/HN/AN are required identifiers — empty is just as invalid as a bad
    // format, and must be flagged red immediately rather than waiting for the
    // server round-trip after Submit to catch it. idCard (rule.required === false)
    // is the exception: not every case has a legible ID card in the photo, so an
    // empty value passes here and is treated as "not yet checked" rather than invalid.
    if (value === '') {
        if (rule.required === false) {
            errEl.classList.add('hidden');
            inputEl.classList.remove('border-red-500');
            inputEl.classList.add('border-neutral-600');
            return true;
        }
        errEl.textContent = `กรุณากรอก ${fieldId.toUpperCase()}`;
        errEl.classList.remove('hidden');
        inputEl.classList.add('border-red-500');
        inputEl.classList.remove('border-neutral-600');
        return false;
    }

    const isValid = rule.pattern.test(value);
    if (!isValid) {
        errEl.textContent = rule.message;
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

    // Verify all inputs are valid before submitting — covers Equipment AND the
    // CCN/HN/AN fields in General Info (both use the same .border-red-500 marker).
    const allInputs = document.querySelectorAll('.case-card input, .case-card textarea');
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
        let allCasesSaved = false;

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

            allCasesSaved = currentCases.every((c, idx) => savedCcns.has(editedData[idx].ccn));

            if (allCasesSaved) {
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
        // Once every case is saved there's nothing left to submit — keep the button
        // permanently disabled instead of re-enabling it for an accidental re-click.
        if (allCasesSaved) {
            btn.disabled = true;
            btn.textContent = 'บันทึกครบทุกเคสแล้ว ✅';
        } else {
            btn.disabled = false;
            btn.textContent = 'บันทึกข้อมูลทั้งหมดเข้า Sheet';
        }
    }
});