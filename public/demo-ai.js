const PREFIX = 'zezo-forge-ai-demo:v1:';

const sampleTickets = [
  { id: 'T-104', name: 'سارة ن.', nameEn: 'Sara N.', topic: 'استفسار عن التوصيل', topicEn: 'Delivery question', preview: 'هل يصل الطلب إلى منطقة خيالية؟', previewEn: 'Can you deliver to the sample area?', status: 'open', reply: '' },
  { id: 'T-103', name: 'محمود ر.', nameEn: 'Mahmoud R.', topic: 'تغيير موعد', topicEn: 'Reschedule', preview: 'أحتاج إلى نقل الموعد إلى الأسبوع القادم.', previewEn: 'I need to move my appointment to next week.', status: 'open', reply: '' },
  { id: 'T-102', name: 'ليان ع.', nameEn: 'Layan A.', topic: 'تفاصيل الخدمة', topicEn: 'Service details', preview: 'هل يمكنني معرفة ما تتضمنه الباقة؟', previewEn: 'Could I learn what is included in the package?', status: 'resolved', reply: 'يسعدنا شرح الخيارات المتاحة لك.', replyEn: 'We are happy to explain the available options.' },
];

const products = [
  { id: 'p1', name: 'سماعة ندى اللاسلكية', en: 'Nada Wireless Earbuds', price: 279, battery: 8, comfort: 9, travel: 7, audio: 8, glyph: '◉' },
  { id: 'p2', name: 'سماعة رِحاب الهادئة', en: 'Rihab Quiet Headphones', price: 369, battery: 9, comfort: 8, travel: 9, audio: 9, glyph: '⌁' },
  { id: 'p3', name: 'سماعة مرسى اليومية', en: 'Marsa Daily Headphones', price: 189, battery: 7, comfort: 7, travel: 8, audio: 7, glyph: '◌' },
];

function initial(id) {
  if (id === 'ai-study-mate') return { tab: 'lesson', card: 0, flipped: false, answer: '', score: 0, completed: false };
  if (id === 'ai-pagebrief') return { doc: 'brief', text: '', level: 'standard', result: null };
  if (id === 'ai-copycraft') return { channel: 'instagram', tone: 'warm', topic: 'افتتاح ركن القراءة في مقهى صغير', result: '', count: 0 };
  if (id === 'ai-signal-board') return { period: 'week', channel: 'all' };
  if (id === 'ai-answerwell') return { category: 'services', question: '', answer: null };
  if (id === 'ai-replydesk') return { selected: 'T-104', filter: 'all', tickets: sampleTickets.map(x => ({ ...x })) };
  if (id === 'ai-cartwise') return { budget: 350, priority: 'balanced', compared: ['p1', 'p2', 'p3'], recommendation: null };
  if (id === 'ai-scopequote') return { type: 'site', pages: 4, integrations: 1, content: 'ready', generated: null };
  return { steps: ['استلام طلب جديد', 'تصنيف نوع الطلب', 'إرسال تنبيه للفريق', 'مراجعة بشرية'], enabled: [true, true, true, true], running: false, progress: 0, done: false };
}

function load(item) {
  const base = initial(item.id);
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREFIX + item.id) || 'null');
    return saved && typeof saved === 'object' ? { ...base, ...saved } : base;
  } catch { return base; }
}

function save(item, state) {
  try { sessionStorage.setItem(PREFIX + item.id, JSON.stringify(state)); } catch {}
}

function label(h, ar, en) { return h.tx(ar, en); }
function esc(h, value) { return h.esc(String(value == null ? '' : value)); }
function btn(h, action, ar, en, extra) {
  return '<button type="button" data-ai-action="' + action + '" ' + (extra || '') + '>' + label(h, ar, en) + '</button>';
}

function common(item, h, state, body) {
  const en = h.lang() === 'en';
  const title = esc(h, item.title[en ? 'en' : 'ar']);
  return '<section class="zfx-ai-demo zfx-ai-' + esc(h, item.kind) + '" data-ai-demo="' + esc(h, item.id) + '" dir="' + (en ? 'ltr' : 'rtl') + '">' +
    '<header class="zfx-ai-top"><div class="zfx-ai-brand"><span class="zfx-ai-brand-mark">✳</span><div><b>' + title + '</b><small>LOCAL CONCEPT / ' + esc(h, item.id.toUpperCase()) + '</small></div></div>' +
    '<div class="zfx-ai-controls"><span class="zfx-ai-local"><i></i>' + label(h, 'محاكاة محلية · بلا API', 'Local simulation · no API') + '</span>' + btn(h, 'reset', 'إعادة ضبط', 'Reset', 'class="zfx-ai-reset"') + '</div></header>' +
    '<div class="zfx-ai-disclosure"><b>ⓘ ' + label(h, 'نسخة توضيحية بقواعد وردود ثابتة، وليست خدمة ذكاء اصطناعي متصلة.', 'A scripted concept with fixed rules and sample data, not a connected AI service.') + '</b><span>' + label(h, 'تعمل بياناتك داخل هذا التبويب فقط ولا تُرسل إلى خادم.', 'Your demo data stays in this browser tab and is not sent to a server.') + '</span></div>' + body +
    '<footer class="zfx-ai-foot"><span>' + label(h, 'بيانات اصطناعية · للاطلاع والتجربة فقط', 'Synthetic sample data · preview only') + '</span><span>ZEZO FORGE / DEMO</span></footer>' +
    '<p class="zfx-ai-notice" data-ai-notice aria-live="polite"></p></section>';
}

function renderStudy(item, h, s) {
  const lessons = [
    ['فكرة أساسية', 'المعلومة الجديدة تثبت عندما تربطها بمثال تعرفه.', 'Key idea', 'New information sticks when you connect it to an example you know.'],
    ['التجزئة', 'قسّم الموضوع إلى وحدات صغيرة، ثم راجع كل وحدة باسترجاع نشط.', 'Chunking', 'Break a topic into small units, then review each with active recall.'],
    ['التطبيق', 'بعد قراءة المفهوم، اشرح كيف تستخدمه في موقف واقعي.', 'Application', 'After reading a concept, explain how you would use it in a real situation.'],
  ];
  const cards = [
    ['ما فائدة الاسترجاع النشط؟', 'اختبار الذاكرة يساعدك على اكتشاف ما تحتاج إلى مراجعته.'],
    ['ما الخطوة المناسبة بعد درس جديد؟', 'أغلق الملاحظات وحاول شرح المفهوم بكلماتك.'],
  ];
  const q = cards[s.card % cards.length];
  const lesson = lessons[s.card % lessons.length];
  const tab = (id, ar, en) => '<button type="button" data-ai-action="study-tab" data-tab="' + id + '" class="' + (s.tab === id ? 'active' : '') + '">' + label(h, ar, en) + '</button>';
  let content = '';
  if (s.tab === 'lesson') content = '<div class="zfx-ai-lesson"><div class="zfx-ai-lesson-number">0' + (s.card + 1) + ' / 03</div><small>' + label(h, lesson[0], lesson[2]) + '</small><h2>' + label(h, lesson[1], lesson[3]) + '</h2><p>' + label(h, 'جرّب أن تلخص الفكرة في جملة واحدة قبل الانتقال إلى البطاقة.', 'Try to summarize the idea in one sentence before moving to the card.') + '</p><div class="zfx-ai-progress"><i style="width:' + ((s.card + 1) * 33) + '%"></i></div><div class="zfx-ai-actions">' + btn(h, 'study-prev', 'السابق', 'Previous', s.card === 0 ? 'disabled' : '') + btn(h, 'study-next', 'الدرس التالي', 'Next lesson', s.card === 2 ? 'disabled' : 'class="zfx-ai-primary"') + '</div></div>';
  else if (s.tab === 'cards') content = '<div class="zfx-ai-flash"><small>' + label(h, 'بطاقة استرجاع', 'Recall card') + ' · 0' + (s.card + 1) + '</small><h2>' + label(h, s.flipped ? q[1] : q[0], s.flipped ? q[1] : q[0]) + '</h2>' + btn(h, 'flip', s.flipped ? 'إظهار السؤال' : 'اكشف الإجابة', s.flipped ? 'Show question' : 'Reveal answer', 'class="zfx-ai-primary"') + '<div class="zfx-ai-actions">' + btn(h, 'card-prev', 'بطاقة سابقة', 'Previous card', s.card === 0 ? 'disabled' : '') + btn(h, 'card-next', 'بطاقة تالية', 'Next card', s.card >= cards.length - 1 ? 'disabled' : '') + '</div></div>';
  else content = '<form class="zfx-ai-quiz" data-ai-form="quiz"><small>' + label(h, 'اختبار سريع · سؤال 1 من 1', 'Quick quiz · question 1 of 1') + '</small><h2>' + label(h, 'ما أفضل طريقة للتأكد من فهم مفهوم جديد؟', 'What is a strong way to check understanding of a new idea?') + '</h2><label><input type="radio" name="answer" value="a" required> ' + label(h, 'إعادة قراءة الصفحة دون توقف', 'Reread the page without pausing') + '</label><label><input type="radio" name="answer" value="b"> ' + label(h, 'شرح المفهوم من الذاكرة مع مثال', 'Explain it from memory with an example') + '</label><button class="zfx-ai-primary">' + label(h, 'تحقق من الإجابة', 'Check answer') + '</button><p>' + (s.completed ? label(h, 'النتيجة: ' + s.score + ' / 1 · ' + (s.score ? 'إجابة صحيحة' : 'حاول مرة أخرى'), 'Score: ' + s.score + ' / 1 · ' + (s.score ? 'Correct' : 'Try again')) : '') + '</p></form>';
  return common(item, h, s, '<div class="zfx-ai-study"><aside><span>STUDY SPACE / DEMO</span><h2>' + label(h, 'خطة مراجعة قصيرة', 'A short review plan') + '</h2><p>' + label(h, '٣ وحدات · ٨ دقائق · وتيرة مرنة', '3 units · 8 minutes · self-paced') + '</p><div class="zfx-ai-study-stat"><b>' + (s.score || 0) + '</b><small>' + label(h, 'نقاط الاختبار', 'Quiz points') + '</small></div><small class="zfx-ai-safe-note">' + label(h, 'المحتوى تعليمي عام وليس بديلاً عن مدرسك.', 'General learning content, not a substitute for your teacher.') + '</small></aside><div class="zfx-ai-work"><nav class="zfx-ai-tabs">' + tab('lesson', 'الدرس', 'Lesson') + tab('cards', 'بطاقات المراجعة', 'Flashcards') + tab('quiz', 'اختبار قصير', 'Quick quiz') + '</nav>' + content + '</div></div>');
}

function renderBrief(item, h, s) {
  const docs = {
    brief: ['ملخص اجتماع إطلاق', 'Launch meeting notes', 'اتفق الفريق على بدء نسخة أولية من دليل الحجز. الأولوية هي البحث عن المواعيد، مراجعة تفاصيل الخدمة، ثم تأكيد الطلب التجريبي. ستُراجع النتائج بعد أسبوعين مع عينة صغيرة من المستخدمين.'],
    policy: ['دليل تجربة المستخدم', 'Customer experience guide', 'تبدأ التجربة بتوضيح الخطوة التالية. يجب أن تظهر حالة الإجراء بعد الضغط، وأن يستطيع المستخدم العودة دون فقد بيانات الجلسة. تراجع لوحة الفريق العناصر المعلقة مرة كل يوم.'],
    research: ['ملاحظات مقابلات قصيرة', 'Short interview notes', 'ذكر المشاركون أن خطوات الحجز الكثيرة تربكهم. ساعدهم عرض الأوقات المتاحة بوضوح على اتخاذ القرار. فضّلوا إظهار التكلفة قبل تأكيد الحجز.'],
  };
  const selected = docs[s.doc] || docs.brief;
  const source = s.text.trim() || label(h, selected[2], selected[2]);
  const options = Object.keys(docs).map(key => '<button type="button" data-ai-action="pick-doc" data-doc="' + key + '" class="' + (s.doc === key ? 'active' : '') + '">' + label(h, docs[key][0], docs[key][1]) + '</button>').join('');
  const result = s.result ? '<section class="zfx-ai-summary-result"><header><b>' + label(h, 'ملخص توضيحي', 'Sample summary') + '</b><span>' + esc(h, s.result.words) + ' ' + label(h, 'كلمة تقريباً', 'words approx.') + '</span></header><h3>' + esc(h, s.result.title) + '</h3><ul>' + s.result.points.map(x => '<li>' + esc(h, x) + '</li>').join('') + '</ul><div class="zfx-ai-summary-footer"><span>' + label(h, 'مستوى التفصيل:', 'Detail:') + ' ' + esc(h, s.level) + '</span><span>' + label(h, 'أُنشئ محلياً من النص التجريبي.', 'Generated locally from sample text.') + '</span></div></section>' : '';
  return common(item, h, s, '<div class="zfx-ai-brief"><aside><span>DOCUMENT DESK / DEMO</span><h2>' + label(h, 'ابدأ بمستند تجريبي', 'Start with a sample document') + '</h2><div class="zfx-ai-doc-list">' + options + '</div><p class="zfx-ai-safe-note">' + label(h, 'لا تلصق مستندات سرية؛ استخدم نصاً تجريبياً فقط.', 'Do not paste confidential documents; use sample text only.') + '</p></aside><div class="zfx-ai-work"><div class="zfx-ai-brief-head"><div><small>' + label(h, 'مصدر التلخيص', 'Summary source') + '</small><h2>' + label(h, selected[0], selected[1]) + '</h2></div><span class="zfx-ai-doc-icon">▤</span></div><label class="zfx-ai-field">' + label(h, 'النص', 'Text') + '<textarea data-ai-input="text" rows="6" maxlength="6000" placeholder="' + label(h, 'الصق نصاً غير حساس هنا...', 'Paste non-sensitive sample text here...') + '">' + esc(h, s.text || '') + '</textarea></label><div class="zfx-ai-form-row"><label>' + label(h, 'درجة الاختصار', 'Summary detail') + '<select data-ai-change="level"><option value="brief" ' + (s.level === 'brief' ? 'selected' : '') + '>' + label(h, 'مختصر جداً', 'Very brief') + '</option><option value="standard" ' + (s.level === 'standard' ? 'selected' : '') + '>' + label(h, 'متوازن', 'Balanced') + '</option><option value="detailed" ' + (s.level === 'detailed' ? 'selected' : '') + '>' + label(h, 'تفصيلي', 'Detailed') + '</option></select></label>' + btn(h, 'summarize', 'إنشاء ملخص تجريبي', 'Create sample summary', 'class="zfx-ai-primary"') + '</div>' + result + '</div></div>');
}

function renderCopy(item, h, s) {
  const channels = [['instagram', 'إنستغرام', 'Instagram'], ['whatsapp', 'واتساب', 'WhatsApp'], ['email', 'بريد إلكتروني', 'Email']];
  const tones = [['warm', 'ودود', 'Warm'], ['direct', 'مباشر', 'Direct'], ['formal', 'رسمي', 'Formal']];
  const select = (name, choices, value) => '<label>' + label(h, name === 'channel' ? 'القناة' : 'النبرة', name === 'channel' ? 'Channel' : 'Tone') + '<select data-ai-change="' + name + '">' + choices.map(x => '<option value="' + x[0] + '" ' + (x[0] === value ? 'selected' : '') + '>' + label(h, x[1], x[2]) + '</option>').join('') + '</select></label>';
  const channelHint = { instagram: ['منشور اجتماعي', 'Social post'], whatsapp: ['رسالة قصيرة', 'Short message'], email: ['رسالة بريدية', 'Email note'] }[s.channel];
  return common(item, h, s, '<div class="zfx-ai-copy"><aside><span>CONTENT WORKBENCH</span><h2>' + label(h, 'جهّز موجز الكتابة', 'Set up a writing brief') + '</h2><p>' + label(h, 'اختر القناة والنبرة ثم أنشئ مسودة محلية قابلة للتحرير.', 'Choose a channel and tone, then create a local editable draft.') + '</p><div class="zfx-ai-copy-steps"><i>01</i>' + label(h, 'الفكرة', 'Idea') + '<i>02</i>' + label(h, 'الصياغة', 'Draft') + '<i>03</i>' + label(h, 'المراجعة', 'Review') + '</div></aside><div class="zfx-ai-work"><div class="zfx-ai-copy-controls">' + select('channel', channels, s.channel) + select('tone', tones, s.tone) + '<label>' + label(h, 'موضوع المحتوى', 'Content topic') + '<input data-ai-input="topic" maxlength="180" value="' + esc(h, s.topic) + '"></label><button type="button" data-ai-action="draft" class="zfx-ai-primary">' + label(h, 'أنشئ مسودة', 'Create a draft') + ' ↗</button></div><div class="zfx-ai-draft"><header><small>' + label(h, channelHint[0], channelHint[1]) + ' / DEMO</small><span>' + s.count + ' ' + label(h, 'مسودات', 'drafts') + '</span></header><textarea data-ai-input="result" rows="6" placeholder="' + label(h, 'ستظهر المسودة هنا لتراجعها وتحررها...', 'Your draft will appear here for review and editing...') + '">' + esc(h, s.result) + '</textarea><div><span>' + label(h, 'راجع الادعاءات والتفاصيل قبل النشر.', 'Review every claim and detail before publishing.') + '</span>' + btn(h, 'clear-draft', 'مسح المسودة', 'Clear draft') + '</div></div></div></div>');
}

function renderAnalytics(item, h, s) {
  const base = s.period === 'month' ? [56, 71, 63, 84, 69, 93, 78, 88] : [42, 58, 49, 75, 61, 88, 68, 96];
  const mult = s.channel === 'social' ? .72 : s.channel === 'email' ? .45 : 1;
  const values = base.map((x, i) => Math.max(12, Math.round(x * mult + (i % 3) * 4)));
  const total = values.reduce((a, b) => a + b, 0);
  const bars = values.map((n, i) => '<div class="zfx-ai-bar-col"><b>' + n + '</b><i style="height:' + n + '%"></i><small>' + (s.period === 'month' ? ['1','5','9','13','17','21','25','30'][i] : ['س','ح','ن','ث','ر','خ','ج','س'][i]) + '</small></div>').join('');
  const channels = [['all', 'كل القنوات', 'All channels'], ['social', 'اجتماعي', 'Social'], ['email', 'البريد', 'Email']];
  return common(item, h, s, '<div class="zfx-ai-analytics"><header><div><small>INSIGHTS / SYNTHETIC DATA</small><h2>' + label(h, 'إشارات مفهومة من أرقام افتراضية', 'Useful signals from sample data') + '</h2></div><div class="zfx-ai-period">' + btn(h, 'period', '٧ أيام', '7 days', 'data-period="week" class="' + (s.period === 'week' ? 'active' : '') + '"') + btn(h, 'period', '٣٠ يوماً', '30 days', 'data-period="month" class="' + (s.period === 'month' ? 'active' : '') + '"') + '</div></header><div class="zfx-ai-metric-grid"><article><small>' + label(h, 'زيارات نموذجية', 'Sample visits') + '</small><b>' + (total * 14) + '</b><span>+' + (s.period === 'month' ? '12.4' : '8.2') + '%</span></article><article><small>' + label(h, 'طلبات توضيحية', 'Sample enquiries') + '</small><b>' + Math.round(total / 22) + '</b><span>' + label(h, 'من البيانات الافتراضية', 'from synthetic data') + '</span></article><article><small>' + label(h, 'معدل التحويل', 'Conversion rate') + '</small><b>3.8%</b><span>' + label(h, 'قيمة تعليمية فقط', 'Illustrative only') + '</span></article></div><div class="zfx-ai-chart-card"><header><b>' + label(h, 'النشاط حسب اليوم', 'Activity by day') + '</b><label>' + label(h, 'القناة', 'Channel') + '<select data-ai-change="channel">' + channels.map(x => '<option value="' + x[0] + '" ' + (s.channel === x[0] ? 'selected' : '') + '>' + label(h, x[1], x[2]) + '</option>').join('') + '</select></label></header><div class="zfx-ai-chart">' + bars + '</div><div class="zfx-ai-legend"><i></i>' + label(h, 'تفاعل افتراضي · لا يمثل بيانات عميل', 'Synthetic engagement · not customer data') + '</div></div><div class="zfx-ai-insight-row"><b>✳ ' + label(h, 'قراءة مقترحة', 'Sample interpretation') + '</b><p>' + label(h, 'تظهر العينة ارتفاعاً قرب نهاية الفترة؛ يمكن لفريق المنتج التحقق من أثر نشر المحتوى في تلك الأيام.', 'The sample rises near the period end; a product team could check whether content activity influenced those days.') + '</p></div></div>');
}

function renderAnswers(item, h, s) {
  const faq = [
    { id: 'services', q: ['ما الخدمات التي تقدمونها؟', 'What services do you offer?'], a: ['يعرض هذا الموقع خدمات تصميم المواقع والتطبيقات، إضافة إلى نماذج دعم وتجارب رقمية. هذه إجابة نموذجية لمحتوى تجريبي.', 'This sample site presents website and app design, plus digital experience concepts. This is a scripted answer from demo content.'], src: 'صفحة الخدمات / نموذج' },
    { id: 'timeline', q: ['كيف أعرف مدة التنفيذ؟', 'How do I know the timeline?'], a: ['تتحدد المدة بعد توضيح النطاق والمتطلبات ومراجعتها مع الفريق. أرسل استفساراً ليتم التواصل معك.', 'Timing depends on the project scope and requirements reviewed with the team. Send an enquiry for follow-up.'], src: 'الأسئلة الشائعة / نموذج' },
    { id: 'contact', q: ['كيف أتواصل مع الفريق؟', 'How can I contact the team?'], a: ['اختر قناة التواصل الظاهرة في صفحة التواصل، وسيتم توجيهك إلى الفريق. لا يرسل هذا النموذج رسائل.', 'Use a contact option shown on the contact page to reach the team. This demo does not send messages.'], src: 'صفحة التواصل / نموذج' },
  ];
  const rows = faq.map(x => '<button type="button" data-ai-action="faq" data-faq="' + x.id + '" class="' + (s.category === x.id ? 'active' : '') + '">' + label(h, x.q[0], x.q[1]) + '</button>').join('');
  const answer = s.answer ? '<article class="zfx-ai-answer"><small>' + label(h, 'إجابة من محتوى الموقع التجريبي', 'Answer from sample site content') + '</small><p>' + label(h, s.answer.ar, s.answer.en) + '</p><span>↳ ' + label(h, s.answer.src, s.answer.src) + '</span></article>' : '';
  return common(item, h, s, '<div class="zfx-ai-answers"><aside><span>WEBSITE KNOWLEDGE / DEMO</span><h2>' + label(h, 'إجابات موثقة من محتوى محدد', 'Answers grounded in a small source set') + '</h2><p>' + label(h, 'اختر سؤالاً مقترحاً أو اكتب سؤالاً. ستظهر الإجابة مع مصدرها إن وجد.', 'Choose a suggested question or write your own. A matching answer includes its source.') + '</p><nav>' + rows + '</nav></aside><div class="zfx-ai-work"><div class="zfx-ai-site-card"><span class="zfx-ai-site-logo">S</span><div><b>' + label(h, 'موقع مركز السلام', 'Al Salam Center website') + '</b><small>3 ' + label(h, 'مصادر تجريبية', 'sample sources') + '</small></div><span class="zfx-ai-indexed">● ' + label(h, 'مفهرس', 'Indexed') + '</span></div><form class="zfx-ai-question" data-ai-form="question"><label>' + label(h, 'اسأل الموقع', 'Ask the website') + '<input name="question" maxlength="180" required value="' + esc(h, s.question) + '" placeholder="' + label(h, 'مثال: ما الخدمات المتاحة؟', 'e.g. What services are offered?') + '"></label><button class="zfx-ai-primary">' + label(h, 'ابحث في المصادر', 'Search sources') + ' ↗</button></form>' + answer + '<small class="zfx-ai-safe-note">' + label(h, 'لا يوجد اتصال بنموذج أو موقع فعلي؛ الإجابات مكتوبة لأغراض العرض.', 'No model or live website is connected; answers are scripted for this preview.') + '</small></div></div>');
}

function renderInbox(item, h, s) {
  const tickets = s.tickets || [];
  const filtered = tickets.filter(x => s.filter === 'all' || x.status === s.filter);
  const selected = tickets.find(x => x.id === s.selected && (s.filter === 'all' || x.status === s.filter)) || filtered[0];
  const list = filtered.map(x => '<button type="button" class="zfx-ai-ticket ' + (x.id === selected?.id ? 'active' : '') + '" data-ai-action="ticket" data-ticket="' + x.id + '"><span class="zfx-ai-ticket-avatar">' + esc(h, x.name.slice(0, 1)) + '</span><span><b>' + esc(h, h.lang() === 'en' ? x.topicEn : x.topic) + '</b><small>' + esc(h, h.lang() === 'en' ? x.nameEn : x.name) + ' · ' + esc(h, x.id) + '</small><i class="zfx-ai-state ' + x.status + '">' + label(h, x.status === 'open' ? 'مفتوح' : 'تمت المعالجة', x.status === 'open' ? 'Open' : 'Resolved') + '</i></span></button>').join('');
  return common(item, h, s, '<div class="zfx-ai-inbox"><header><div><small>REPLY DESK / LOCAL QUEUE</small><h2>' + label(h, 'صندوق متابعة تجريبي', 'Sample customer inbox') + '</h2></div><span>' + tickets.filter(x => x.status === 'open').length + ' ' + label(h, 'مفتوح', 'open') + '</span></header><div class="zfx-ai-inbox-grid"><aside><div class="zfx-ai-inbox-filters">' + btn(h, 'filter', 'الكل', 'All', 'data-filter="all" class="' + (s.filter === 'all' ? 'active' : '') + '"') + btn(h, 'filter', 'مفتوح', 'Open', 'data-filter="open" class="' + (s.filter === 'open' ? 'active' : '') + '"') + btn(h, 'filter', 'تمت المعالجة', 'Resolved', 'data-filter="resolved" class="' + (s.filter === 'resolved' ? 'active' : '') + '"') + '</div><div class="zfx-ai-ticket-list">' + (list || '<p class="zfx-ai-empty">' + label(h, 'لا توجد استفسارات في هذا العرض.', 'No enquiries in this view.') + '</p>') + '</div></aside><section class="zfx-ai-reply-panel">' + (selected ? '<header><span class="zfx-ai-ticket-avatar">' + esc(h, selected.name.slice(0, 1)) + '</span><div><b>' + esc(h, h.lang() === 'en' ? selected.nameEn : selected.name) + '</b><small>' + esc(h, selected.id) + ' · ' + esc(h, h.lang() === 'en' ? selected.topicEn : selected.topic) + '</small></div><span class="zfx-ai-scripted">' + label(h, 'رد مقترح', 'Drafted reply') + '</span></header><div class="zfx-ai-customer-msg"><small>' + label(h, 'رسالة نموذجية', 'Sample message') + '</small><p>' + esc(h, h.lang() === 'en' ? selected.previewEn : selected.preview) + '</p></div><label>' + label(h, 'عدّل الرد قبل اعتماده', 'Edit reply before marking reviewed') + '<textarea data-ai-ticket-reply rows="5" maxlength="400">' + esc(h, selected.reply || label(h, 'شكراً لتواصلك معنا. يسعدنا مساعدتك، وسنراجع التفاصيل مع الفريق.', 'Thanks for reaching out. We are happy to help and will review the details with our team.')) + '</textarea></label><p class="zfx-ai-safe-note">' + label(h, 'المقترح نص ثابت للمراجعة ولا يُرسل للعميل.', 'This scripted suggestion is for review and is not sent to the customer.') + '</p><div class="zfx-ai-actions">' + btn(h, 'resolve-ticket', 'تسجيل كمُعالج', 'Mark resolved', 'class="zfx-ai-primary" ' + (!selected || selected.status === 'resolved' ? 'disabled' : '')) + btn(h, 'reopen-ticket', 'إعادة فتح', 'Reopen', ' ' + (!selected || selected.status === 'open' ? 'disabled' : '')) + '</div>' : '<div class="zfx-ai-empty">' + label(h, 'اختر استفساراً من القائمة.', 'Choose an enquiry from the list.') + '</div>') + '</section></div></div>');
}

function renderCartwise(item, h, s) {
  const budget = Number(s.budget) || 0;
  const visible = products.filter(p => p.price <= budget);
  const best = visible.length ? [...visible].sort((a, b) => {
    const score = p => s.priority === 'battery' ? p.battery * 2 + p.audio + p.comfort : s.priority === 'travel' ? p.travel * 2 + p.comfort + p.battery : p.audio + p.comfort + p.battery + p.travel;
    return score(b) - score(a);
  })[0] : null;
  const cards = products.map(p => '<article class="zfx-ai-product ' + (p.price > budget ? 'over-budget' : '') + '"><div class="zfx-ai-product-art">' + p.glyph + '<small>' + (p.price > budget ? label(h, 'فوق الميزانية', 'Over budget') : label(h, 'ضمن الميزانية', 'In budget')) + '</small></div><div><small>DEMO · AUDIO</small><h3>' + label(h, p.name, p.en) + '</h3><b>' + h.money(p.price) + '</b></div><div class="zfx-ai-specs"><span>' + label(h, 'بطارية', 'Battery') + '<b>' + p.battery + '/10</b></span><span>' + label(h, 'راحة', 'Comfort') + '<b>' + p.comfort + '/10</b></span><span>' + label(h, 'تنقل', 'Travel') + '<b>' + p.travel + '/10</b></span><span>' + label(h, 'صوت', 'Sound') + '<b>' + p.audio + '/10</b></span></div><label><input type="checkbox" data-ai-compare="' + p.id + '" ' + (s.compared.includes(p.id) ? 'checked' : '') + '> ' + label(h, 'أضف للمقارنة', 'Compare') + '</label></article>').join('');
  const rec = s.recommendation ? '<div class="zfx-ai-recommend"><span>✳</span><div><small>' + label(h, 'الاقتراح حسب قواعد العينة', 'Sample rule-based suggestion') + '</small><b>' + (best ? label(h, best.name, best.en) : label(h, 'لا يوجد خيار ضمن الميزانية الحالية', 'No option fits the current budget')) + '</b><p>' + label(h, best ? 'طابق الاختيار تفضيلك، ثم راجع المواصفات بنفسك قبل القرار.' : 'ارفع الحد أو غيّر الفلاتر لعرض خيارات مناسبة.', best ? 'This option best matches your preference; review the specifications before deciding.' : 'Raise the budget or adjust filters to see suitable options.') + '</p></div></div>' : '';
  return common(item, h, s, '<div class="zfx-ai-cartwise"><header><div><small>CARTWISE / SAMPLE CATALOG</small><h2>' + label(h, 'قارن الخيارات وفق احتياجك', 'Compare products around your needs') + '</h2></div><span>3 ' + label(h, 'منتجات نموذجية', 'sample products') + '</span></header><div class="zfx-ai-cart-controls"><label>' + label(h, 'الحد الأعلى للسعر', 'Maximum budget') + '<input type="range" min="150" max="450" step="10" data-ai-change="budget" value="' + budget + '"><b>' + h.money(budget) + '</b></label><label>' + label(h, 'الأولوية', 'Priority') + '<select data-ai-change="priority"><option value="balanced" ' + (s.priority === 'balanced' ? 'selected' : '') + '>' + label(h, 'متوازن', 'Balanced') + '</option><option value="battery" ' + (s.priority === 'battery' ? 'selected' : '') + '>' + label(h, 'عمر البطارية', 'Battery life') + '</option><option value="travel" ' + (s.priority === 'travel' ? 'selected' : '') + '>' + label(h, 'للتنقل', 'Travel') + '</option></select></label>' + btn(h, 'recommend', 'اقترح الأنسب', 'Find a match', 'class="zfx-ai-primary"') + '</div><div class="zfx-ai-product-grid">' + cards + '</div><div class="zfx-ai-compare-footer"><span>' + s.compared.length + ' ' + label(h, 'في قائمة المقارنة', 'in comparison') + '</span>' + btn(h, 'compare', 'اعرض المقارنة', 'View comparison') + '</div>' + (s.compareOpen ? '<div class="zfx-ai-compare-table"><b>' + label(h, 'مقارنة المواصفات المختارة', 'Selected product comparison') + '</b><div>' + ['battery','comfort','travel','audio'].map(k => '<span>' + label(h, ({battery:['البطارية','Battery'],comfort:['الراحة','Comfort'],travel:['التنقل','Travel'],audio:['الصوت','Audio']})[k][0], ({battery:['البطارية','Battery'],comfort:['الراحة','Comfort'],travel:['التنقل','Travel'],audio:['الصوت','Audio']})[k][1]) + ' · ' + products.filter(p => s.compared.includes(p.id)).map(p => label(h, p.name, p.en) + ' ' + p[k] + '/10').join(' · ') + '</span>').join('') + '</div></div>' : '') + rec + '<small class="zfx-ai-safe-note">' + label(h, 'الأسعار والمواصفات خيالية لأغراض العرض، والاقتراح حساب توضيحي.', 'Prices and specs are fictional; the recommendation is an illustrative calculation.') + '</small></div>');
}

function renderScope(item, h, s) {
  const types = [['site', 'موقع تعريفي', 'Business website', 5], ['store', 'متجر إلكتروني', 'Online store', 8], ['app', 'تطبيق ويب', 'Web app', 10]];
  const type = types.find(x => x[0] === s.type) || types[0];
  const work = type[3] + Number(s.pages) * 1.4 + Number(s.integrations) * 2.5 + (s.content === 'write' ? 5 : 0);
  const low = Math.round(work * .82);
  const high = Math.round(work * 1.24);
  const result = s.generated ? '<section class="zfx-ai-scope-result"><small>' + label(h, 'النطاق التوضيحي · تقدير ساعات فقط', 'Sample scope · hours only') + '</small><b>' + low + '–' + high + ' ' + label(h, 'ساعة عمل افتراضية', 'sample effort hours') + '</b><p>' + label(h, 'هذا ناتج قاعدة بسيطة للتجربة. لا يمثل عرض سعر من ZEZO ولا يشمل مراجعة متطلبات فعلية.', 'This is a simple demo rule. It is not a ZEZO quote and does not replace a real requirements review.') + '</p><ul><li>' + label(h, type[1], type[2]) + '</li><li>' + s.pages + ' ' + label(h, 'صفحات/شاشات', 'pages/screens') + '</li><li>' + s.integrations + ' ' + label(h, 'تكاملات تقديرية', 'sample integrations') + '</li><li>' + label(h, s.content === 'write' ? 'المحتوى يحتاج إعداداً' : 'المحتوى جاهز', s.content === 'write' ? 'Content needs preparation' : 'Content is ready') + '</li></ul></section>' : '';
  return common(item, h, s, '<div class="zfx-ai-scope"><aside><small>SCOPE BUILDER / DEMO</small><h2>' + label(h, 'حوّل الفكرة إلى نطاق أولي', 'Turn an idea into an initial scope') + '</h2><p>' + label(h, 'غيّر المدخلات وشاهد أثرها على تقدير الجهد.', 'Adjust the inputs and see how they affect sample effort.') + '</p><div class="zfx-ai-scope-form"><label>' + label(h, 'نوع المشروع', 'Project type') + '<select data-ai-change="type">' + types.map(x => '<option value="' + x[0] + '" ' + (s.type === x[0] ? 'selected' : '') + '>' + label(h, x[1], x[2]) + '</option>').join('') + '</select></label><label>' + label(h, 'صفحات أو شاشات', 'Pages or screens') + '<input data-ai-change="pages" type="number" min="1" max="30" value="' + s.pages + '"></label><label>' + label(h, 'تكاملات خارجية', 'External integrations') + '<input data-ai-change="integrations" type="number" min="0" max="10" value="' + s.integrations + '"></label><label>' + label(h, 'المحتوى', 'Content') + '<select data-ai-change="content"><option value="ready" ' + (s.content === 'ready' ? 'selected' : '') + '>' + label(h, 'جاهز', 'Ready') + '</option><option value="write" ' + (s.content === 'write' ? 'selected' : '') + '>' + label(h, 'يحتاج كتابة', 'Needs writing') + '</option></select></label><button type="button" class="zfx-ai-primary" data-ai-action="estimate">' + label(h, 'احسب النطاق التجريبي', 'Calculate sample scope') + ' ↗</button></div></aside><div class="zfx-ai-work"><div class="zfx-ai-scope-visual"><span>ESTIMATOR</span><div><i></i><i></i><i></i></div><small>' + label(h, 'نطاق واضح يبدأ بسؤال جيد', 'A clear scope starts with good questions') + '</small></div>' + result + '<div class="zfx-ai-assumptions"><b>' + label(h, 'الافتراضات المستخدمة', 'Assumptions') + '</b><p>' + label(h, 'النطاقات تقديرية، لا تحسب الاستضافة أو ترخيص البرامج أو إعادة العمل الناتجة عن تغيير المتطلبات.', 'Effort bands are illustrative and exclude hosting, software licenses, and rework from changing requirements.') + '</p></div></div></div>');
}

function renderFlow(item, h, s) {
  const steps = (s.steps || []).map((step, i) => '<label class="zfx-ai-flow-step"><input type="checkbox" data-ai-step="' + i + '" ' + (s.enabled[i] ? 'checked' : '') + ' ' + (s.running ? 'disabled' : '') + '><span><i>' + String(i + 1).padStart(2, '0') + '</i><b>' + esc(h, step) + '</b><small>' + label(h, 'إجراء محلي داخل محاكاة سير العمل', 'Local action in this workflow simulation') + '</small></span>' + (s.running && s.progress === i ? '<em>' + label(h, 'يعمل', 'Running') + '</em>' : s.done && s.enabled[i] && i < s.progress ? '<em class="complete">✓ ' + label(h, 'اكتمل', 'Done') + '</em>' : '') + '</label>').join('');
  return common(item, h, s, '<div class="zfx-ai-flow"><header><div><small>FLOWPILOT / SCENARIO BUILDER</small><h2>' + label(h, 'رتّب الأتمتة واختبر مسارها', 'Arrange automation and test the flow') + '</h2></div><span class="zfx-ai-flow-count">' + s.steps.filter((_, i) => s.enabled[i]).length + ' ' + label(h, 'خطوات مفعلة', 'steps enabled') + '</span></header><div class="zfx-ai-flow-board"><aside><small>' + label(h, 'عند حدوث', 'WHEN THIS HAPPENS') + '</small><b>' + label(h, 'وصول طلب جديد', 'A new enquiry arrives') + '</b><p>' + label(h, 'مشغل تجريبي', 'Sample trigger') + '</p></aside><div class="zfx-ai-flow-connector">↓</div><section><header><b>' + label(h, 'إذا حدث ذلك، نفّذ', 'THEN RUN') + '</b><span>LOCAL / DEMO</span></header><div class="zfx-ai-flow-list">' + steps + '</div><div class="zfx-ai-actions">' + btn(h, 'run-flow', s.running ? 'جارٍ تشغيل السيناريو…' : 'شغّل السيناريو', s.running ? 'Running scenario…' : 'Run scenario', 'class="zfx-ai-primary" ' + (s.running ? 'disabled' : '')) + btn(h, 'add-step', 'إضافة خطوة', 'Add a step', s.running ? 'disabled' : '') + '</div></section></div><div class="zfx-ai-flow-log"><b>' + label(h, 'سجل التنفيذ المحلي', 'Local run log') + '</b><p>' + (s.done ? label(h, 'انتهى السيناريو التجريبي بعد المرور على الخطوات المفعلة. لم يتم إرسال إشعار أو تنفيذ عملية خارجية.', 'The sample flow completed through enabled steps. No notification or external action was sent.') : label(h, 'لم يتم تشغيل السيناريو بعد.', 'The scenario has not been run yet.')) + '</p></div><small class="zfx-ai-safe-note">' + label(h, 'المحاكاة لا تتصل بالبريد أو CRM أو أي خدمة خارجية.', 'This simulation does not connect to email, CRM, or external services.') + '</small></div>');
}

export function renderAiDemo(item, helpers) {
  const s = load(item);
  if (item.id === 'ai-study-mate') return renderStudy(item, helpers, s);
  if (item.id === 'ai-pagebrief') return renderBrief(item, helpers, s);
  if (item.id === 'ai-copycraft') return renderCopy(item, helpers, s);
  if (item.id === 'ai-signal-board') return renderAnalytics(item, helpers, s);
  if (item.id === 'ai-answerwell') return renderAnswers(item, helpers, s);
  if (item.id === 'ai-replydesk') return renderInbox(item, helpers, s);
  if (item.id === 'ai-cartwise') return renderCartwise(item, helpers, s);
  if (item.id === 'ai-scopequote') return renderScope(item, helpers, s);
  if (item.id === 'ai-flowpilot') return renderFlow(item, helpers, s);
  return '<section class="zfx-ai-demo zfx-ai-unsupported"><p>' + helpers.tx('هذه المعاينة غير متاحة.', 'This preview is not available.') + '</p></section>';
}

function setNotice(root, h, ar, en, error) {
  const node = root.querySelector('[data-ai-notice]');
  if (node) {
    node.textContent = h.tx(ar, en);
    node.classList.toggle('error', Boolean(error));
    node.classList.add('show');
    clearTimeout(node._hide);
    node._hide = setTimeout(() => node.classList.remove('show'), 2400);
  } else h.notice(h.tx(ar, en), Boolean(error));
}

export function mountAiDemo(root, item, helpers) {
  if (!root || !item || root.dataset.aiDemoMount === item.id) return;
  root.dataset.aiDemoMount = item.id;
  const render = () => { root.innerHTML = renderAiDemo(item, helpers); };
  const change = fn => { const s = load(item); fn(s); save(item, s); render(); };
  root.addEventListener('click', event => {
    const el = event.target.closest('[data-ai-action]');
    if (!el) return;
    const s = load(item);
    const action = el.dataset.aiAction;
    if (action === 'reset') { save(item, initial(item.id)); render(); setNotice(root, helpers, 'أُعيد ضبط هذه التجربة المحلية.', 'This local demo was reset.'); return; }
    if (action === 'study-tab') { change(x => { x.tab = el.dataset.tab; }); return; }
    if (action === 'study-next' || action === 'card-next') { change(x => { x.card = Math.min(action === 'study-next' ? 2 : 1, x.card + 1); x.flipped = false; }); return; }
    if (action === 'study-prev' || action === 'card-prev') { change(x => { x.card = Math.max(0, x.card - 1); x.flipped = false; }); return; }
    if (action === 'flip') { change(x => { x.flipped = !x.flipped; }); return; }
    if (action === 'pick-doc') { change(x => { x.doc = el.dataset.doc; x.result = null; }); return; }
    if (action === 'summarize') {
      const text = s.text.trim() || (item.id === 'ai-pagebrief' ? 'اتفق الفريق على بدء نسخة أولية من دليل الحجز. الأولوية هي البحث عن المواعيد، مراجعة تفاصيل الخدمة، ثم تأكيد الطلب التجريبي. ستُراجع النتائج بعد أسبوعين مع عينة صغيرة من المستخدمين.' : '');
      if (!text) { setNotice(root, helpers, 'أدخل نصاً تجريبياً أو اختر مستنداً.', 'Enter sample text or select a document.', true); return; }
      change(x => {
        const sentences = text.split(/[.!?؟\n]+/).map(v => v.trim()).filter(Boolean);
        const count = x.level === 'brief' ? 2 : x.level === 'detailed' ? 5 : 3;
        const points = sentences.slice(0, count);
        x.result = { title: x.doc === 'brief' ? 'اجتماع إطلاق دليل الحجز' : x.doc, words: Math.max(12, Math.round(text.split(/\s+/).length * .35)), points: points.length ? points : [text.slice(0, 180)] };
      });
      setNotice(root, helpers, 'تم إعداد ملخص محلي توضيحي.', 'A local sample summary is ready.'); return;
    }
    if (action === 'draft') {
      const topic = s.topic.trim();
      if (!topic) { setNotice(root, helpers, 'اكتب موضوعاً قبل إنشاء المسودة.', 'Enter a topic before creating a draft.', true); return; }
      const tone = { warm: ['بكل سرور، ', 'We are happy to share: '], direct: ['', 'Here is the update: '], formal: ['يسرّنا أن نشارككم: ', 'We are pleased to share: '] }[s.tone] || ['', ''];
      const channel = { instagram: ['✦ ' + topic + '\n\nتفاصيل صغيرة تصنع لحظات جميلة. شاركنا رأيك في التعليقات. #تجربة_جديدة', '✦ ' + topic + '\n\nSmall details create memorable moments. Tell us what you think. #NewExperience'], whatsapp: [tone[0] + topic + '. يسعدنا أن نسمع رأيك؛ أخبرنا إذا أردت التفاصيل.', tone[1] + topic + '. We would love your thoughts; reply if you would like details.'], email: ['الموضوع: ' + topic + '\n\n' + tone[0] + 'ندعوك للاطلاع على التفاصيل ومشاركة ملاحظاتك معنا.', 'Subject: ' + topic + '\n\n' + tone[1] + 'Please review the details and share your feedback.'] }[s.channel];
      change(x => { x.result = channel[helpers.lang() === 'en' ? 1 : 0]; x.count += 1; });
      setNotice(root, helpers, 'أُنشئت مسودة نموذجية للمراجعة.', 'A sample draft is ready for review.'); return;
    }
    if (action === 'period') { change(x => { x.period = el.dataset.period; }); return; }
    if (action === 'faq') { change(x => { x.category = el.dataset.faq; const row = [{ id: 'services', ar: 'يعرض هذا الموقع خدمات تصميم المواقع والتطبيقات، إضافة إلى نماذج دعم وتجارب رقمية.', en: 'This sample site presents website and app design, plus digital experience concepts.', src: 'صفحة الخدمات / نموذج' }, { id: 'timeline', ar: 'تتحدد المدة بعد توضيح النطاق والمتطلبات ومراجعتها مع الفريق.', en: 'Timing depends on project scope and requirements reviewed with the team.', src: 'الأسئلة الشائعة / نموذج' }, { id: 'contact', ar: 'اختر قناة التواصل الظاهرة في صفحة التواصل، وسيتم توجيهك إلى الفريق.', en: 'Use a contact option shown on the contact page to reach the team.', src: 'صفحة التواصل / نموذج' }].find(y => y.id === el.dataset.faq); x.answer = row ? { ar: row.ar, en: row.en, src: row.src } : null; }); return; }
    if (action === 'ticket') { change(x => { x.selected = el.dataset.ticket; }); return; }
    if (action === 'filter') { change(x => { x.filter = el.dataset.filter; }); return; }
    if (action === 'resolve-ticket' || action === 'reopen-ticket') {
      const textarea = root.querySelector('[data-ai-ticket-reply]');
      change(x => { const ticket = x.tickets.find(y => y.id === x.selected); if (ticket) { ticket.status = action === 'resolve-ticket' ? 'resolved' : 'open'; ticket.reply = textarea ? textarea.value : ticket.reply; } });
      setNotice(root, helpers, action === 'resolve-ticket' ? 'حُفظ الرد في سجل التجربة ولم يُرسل.' : 'أُعيد فتح الاستفسار التجريبي.', action === 'resolve-ticket' ? 'Reply saved in the demo; nothing was sent.' : 'Sample enquiry reopened.'); return;
    }
    if (action === 'recommend') { change(x => { x.recommendation = true; }); setNotice(root, helpers, 'تم ترتيب الخيارات حسب تفضيلك.', 'Options ranked by your preference.'); return; }
    if (action === 'compare') { change(x => { x.compareOpen = !x.compareOpen; }); return; }
    if (action === 'estimate') { change(x => { x.generated = true; }); setNotice(root, helpers, 'أُنشئ نطاق جهد تقريبي للتجربة فقط.', 'A sample effort range is ready.'); return; }
    if (action === 'add-step') { if (s.steps.length >= 8) { setNotice(root, helpers, 'وصلت إلى الحد الأقصى للخطوات في المعاينة.', 'The demo has reached its step limit.', true); return; } change(x => { x.steps.push('مراجعة يدوية إضافية'); x.enabled.push(true); x.done = false; }); return; }
    if (action === 'run-flow') {
      if (s.running) return;
      change(x => { x.running = true; x.progress = -1; x.done = false; });
      const enabled = s.steps.map((_, i) => s.enabled[i] ? i : -1).filter(i => i >= 0);
      let step = 0;
      const advance = () => {
        const current = load(item);
        if (step >= enabled.length) { current.running = false; current.done = true; current.progress = current.steps.length; save(item, current); render(); setNotice(root, helpers, 'اكتمل السيناريو المحلي دون اتصالات خارجية.', 'Local scenario completed with no external calls.'); return; }
        current.progress = enabled[step]; current.done = false; save(item, current); render();
        step += 1; setTimeout(advance, 550);
      };
      advance(); return;
    }
  });
  root.addEventListener('input', event => {
    const input = event.target;
    if (input.matches('[data-ai-input]')) { const s = load(item); s[input.dataset.aiInput] = input.value; save(item, s); }
    if (input.matches('[data-ai-ticket-reply]')) { const s = load(item); const ticket = s.tickets.find(x => x.id === s.selected); if (ticket) { ticket.reply = input.value; save(item, s); } }
  });
  root.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-ai-change]')) {
      change(s => {
        const key = el.dataset.aiChange;
        if (key === 'pages' || key === 'integrations' || key === 'budget') s[key] = Number(el.value) || 0;
        else s[key] = el.value;
      }); return;
    }
    if (el.matches('[data-ai-compare]')) { change(s => { if (el.checked) { if (!s.compared.includes(el.dataset.aiCompare)) s.compared.push(el.dataset.aiCompare); } else s.compared = s.compared.filter(x => x !== el.dataset.aiCompare); }); return; }
    if (el.matches('[data-ai-step]')) { change(s => { s.enabled[Number(el.dataset.aiStep)] = el.checked; s.done = false; }); return; }
    if (el.matches('[data-ai-change=\"level\"]')) { change(s => { s.level = el.value; }); return; }
  });
  root.addEventListener('submit', event => {
    const form = event.target.closest('[data-ai-form]');
    if (!form) return;
    event.preventDefault();
    const s = load(item);
    if (form.dataset.aiForm === 'quiz') {
      const data = new FormData(form);
      const score = data.get('answer') === 'b' ? 1 : 0;
      change(x => { x.score = score; x.completed = true; });
      setNotice(root, helpers, score ? 'إجابة صحيحة — أحسنت.' : 'راجع الدرس ثم حاول مرة أخرى.', score ? 'Correct — well done.' : 'Review the lesson and try again.');
    }
    if (form.dataset.aiForm === 'question') {
      const data = new FormData(form);
      const question = String(data.get('question') || '').trim();
      if (!question) return;
      const pool = [{ id: 'services', ar: 'يعرض هذا الموقع خدمات تصميم المواقع والتطبيقات، إضافة إلى نماذج دعم وتجارب رقمية.', en: 'This sample site presents website and app design, plus digital experience concepts.', src: 'صفحة الخدمات / نموذج' }, { id: 'timeline', ar: 'تتحدد المدة بعد توضيح النطاق والمتطلبات ومراجعتها مع الفريق.', en: 'Timing depends on project scope and requirements reviewed with the team.', src: 'الأسئلة الشائعة / نموذج' }, { id: 'contact', ar: 'اختر قناة التواصل الظاهرة في صفحة التواصل، وسيتم توجيهك إلى الفريق.', en: 'Use a contact option shown on the contact page to reach the team.', src: 'صفحة التواصل / نموذج' }];
      const lower = question.toLowerCase();
      const found = pool.find(x => (x.id === 'services' && /خدم|service|offer/.test(lower)) || (x.id === 'timeline' && /مدة|وقت|timeline|long/.test(lower)) || (x.id === 'contact' && /تواصل|اتصل|contact/.test(lower)));
      change(x => { x.question = question; x.answer = found ? { ar: found.ar, en: found.en, src: found.src } : { ar: 'لم أجد جواباً مطابقاً في المصادر التجريبية. جرّب سؤالاً عن الخدمات أو المدة أو التواصل.', en: 'No matching answer was found in the sample sources. Try asking about services, timing, or contact.', src: 'لا يوجد تطابق / No match' }; });
    }
  });
  render();
}
