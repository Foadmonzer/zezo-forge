const PREFIX = 'zezo-forge-ideas:v1:';

const ids = [
  'idea-venture-check', 'idea-business-canvas', 'idea-investor-deck', 'idea-mvp-map',
  'idea-launch-sequence', 'idea-mark-studio', 'idea-product-brief', 'idea-growth-loop',
  'idea-capstone', 'idea-scale-map'
];

const copy = {
  'idea-venture-check': {
    eyebrow: ['FEASIBILITY / WORKSHEET', 'FEASIBILITY / WORKSHEET'],
    title: ['مساحة قرار، قبل أن تبدأ.', 'A clearer decision before you begin.'],
    intro: ['عدّل الافتراضات لتشاهد نقطة التعادل والنتيجة الشهرية. هذه أرقام تجريبية للتوضيح وليست توصية مالية.', 'Adjust the assumptions to see break-even and monthly results. These sample figures are for demonstration, not financial advice.']
  },
  'idea-business-canvas': {
    eyebrow: ['BUSINESS MODEL / CANVAS', 'BUSINESS MODEL / CANVAS'],
    title: ['فكرة واحدة. صورة العمل كاملة.', 'One idea. The whole business in view.'],
    intro: ['املأ عناصر نموذج العمل التسعة، ثم احفظ نسخة محلية أو صدّر مسودتك.', 'Fill the nine business model blocks, then save locally or export a draft.']
  },
  'idea-investor-deck': {
    eyebrow: ['PITCH / STORYBOARD', 'PITCH / STORYBOARD'],
    title: ['رتّب قصتك، شريحة بعد شريحة.', 'Shape the story, one slide at a time.'],
    intro: ['استعرض تسلسلاً أولياً للعرض وعدّل نص كل شريحة. لا يتضمن توقعات مالية أو نتائج مختلقة.', 'Preview a first-pass deck and edit each slide. No financial projections or fabricated outcomes are included.']
  },
  'idea-mvp-map': {
    eyebrow: ['PRODUCT / FIRST RELEASE', 'PRODUCT / FIRST RELEASE'],
    title: ['ابدأ بأصغر نسخة تحل المشكلة.', 'Start with the smallest version that solves the problem.'],
    intro: ['عرّف المستخدم والمشكلة، ثم رتّب الميزات حول هدف يمكن قياسه.', 'Define the user and problem, then prioritize features around a measurable goal.']
  },
  'idea-launch-sequence': {
    eyebrow: ['LAUNCH / FIELD PLAN', 'LAUNCH / FIELD PLAN'],
    title: ['من التحضير إلى يوم الإطلاق.', 'From preparation to launch day.'],
    intro: ['حوّل الفكرة إلى قائمة مسؤوليات وتوقيتات قابلة للتعديل. استخدم أسابيع نسبية تناسب جدولك.', 'Turn an idea into an editable checklist with owners and timing. Relative weeks adapt to your schedule.']
  },
  'idea-mark-studio': {
    eyebrow: ['BRAND / IDENTITY LAB', 'BRAND / IDENTITY LAB'],
    title: ['امنح مشروعك ملامح واضحة.', 'Give your project a recognizable identity.'],
    intro: ['عدّل اسم العلامة ونبرتها ولوحتها اللونية وشاهد تصوراً بصرياً فورياً.', 'Edit the brand name, tone, and palette to see an immediate visual direction.']
  },
  'idea-product-brief': {
    eyebrow: ['PRODUCT / REQUIREMENTS', 'PRODUCT / REQUIREMENTS'],
    title: ['اتفاق واضح قبل بدء التطوير.', 'Align on the brief before development starts.'],
    intro: ['سجّل الهدف والمستخدمين والمتطلبات ومعايير القبول في وثيقة واحدة.', 'Capture the goal, users, requirements, and acceptance criteria in one brief.']
  },
  'idea-growth-loop': {
    eyebrow: ['GROWTH / CAMPAIGN PLANNER', 'GROWTH / CAMPAIGN PLANNER'],
    title: ['رسالة مناسبة. قناة محددة. قياس واضح.', 'A useful message. A focused channel. A clear measure.'],
    intro: ['خطط لحملة قابلة للمراجعة من دون وعود بنتائج أو شراء إعلانات.', 'Plan a reviewable campaign without promising outcomes or purchasing ads.']
  },
  'idea-capstone': {
    eyebrow: ['CAPSTONE / PROJECT BOARD', 'CAPSTONE / PROJECT BOARD'],
    title: ['اجعل مشروع التخرج قابلاً للتنفيذ.', 'Make your capstone project manageable.'],
    intro: ['قسّم المشروع إلى مراحل ومخرجات ومواعيد، وتابع تقدم الخطة.', 'Break the project into milestones, deliverables, and dates, then track progress.']
  },
  'idea-scale-map': {
    eyebrow: ['PRODUCT / ROADMAP', 'PRODUCT / ROADMAP'],
    title: ['اختر الخطوة التالية بوعي.', 'Choose the next step with intent.'],
    intro: ['رتّب فرص المنتج حسب المرحلة والأولوية، ثم اربطها بإشارة نجاح قابلة للرصد.', 'Organize product opportunities by stage and priority, then connect them to an observable success signal.']
  }
};

const initial = {
  'idea-venture-check': {
    fields: { concept: 'مقهى حيّ صغير', monthlyCustomers: 420, averageSale: 24, variableCost: 9, fixedCosts: 6200, currency: '₪' }
  },
  'idea-business-canvas': {
    fields: { segments: 'طلاب وموظفو المنطقة', value: 'قهوة يومية جيدة، قريبة وسريعة', channels: 'الموقع، خرائط، توصية العملاء', relationships: 'طلب مباشر وبرنامج ولاء بسيط', revenue: 'مشروبات ووجبات خفيفة', resources: 'فريق صغير، معدات، موقع مناسب', activities: 'التحضير، الخدمة، متابعة الجودة', partners: 'مورد قهوة ومخبز محلي', costs: 'إيجار، مواد، تشغيل، أجور' }
  },
  'idea-investor-deck': {
    fields: { venture: 'اكتب اسم فكرتك', ask: 'ما الدعم أو الخطوة التي تطلبها؟' },
    index: 0,
    slides: [
      { title: 'الفكرة', body: 'قدّم المشروع في جملة واحدة واضحة.' },
      { title: 'المشكلة', body: 'ما المشكلة المحددة التي تلاحظها، ولدى من؟' },
      { title: 'الحل', body: 'اشرح كيف تعالج الفكرة المشكلة بطريقة عملية.' },
      { title: 'المستخدم', body: 'من المستخدم الأول؟ وما حاجته الأساسية؟' },
      { title: 'طريقة العمل', body: 'كيف سيصل الحل للمستخدم، وما الذي يلزم لتشغيله؟' },
      { title: 'الخطوة القادمة', body: 'حدّد تجربة صغيرة أو شراكة أو قراراً تحتاجه.' }
    ]
  },
  'idea-mvp-map': {
    fields: { user: 'صاحب متجر محلي', problem: 'يصعب عليه متابعة الطلبات من قنوات متفرقة', outcome: 'الوقت اللازم لتأكيد الطلب' },
    features: [
      { id: 'mvp-1', text: 'قائمة موحدة للطلبات', priority: 'must', checked: true },
      { id: 'mvp-2', text: 'تحديث حالة الطلب', priority: 'must', checked: true },
      { id: 'mvp-3', text: 'تقارير متقدمة', priority: 'later', checked: false }
    ]
  },
  'idea-launch-sequence': {
    tasks: [
      { id: 'launch-1', title: 'تحديد الجمهور والرسالة', phase: 'قبل الإطلاق', week: 'الأسبوع 1', owner: 'فريق المشروع', done: true },
      { id: 'launch-2', title: 'مراجعة صفحة المنتج', phase: 'قبل الإطلاق', week: 'الأسبوع 2', owner: 'المحتوى', done: false },
      { id: 'launch-3', title: 'تجربة رحلة التسجيل', phase: 'يوم الإطلاق', week: 'الأسبوع 3', owner: 'المنتج', done: false },
      { id: 'launch-4', title: 'جمع الملاحظات وترتيبها', phase: 'بعد الإطلاق', week: 'الأسبوع 4', owner: 'الفريق', done: false }
    ]
  },
  'idea-mark-studio': {
    fields: { name: 'مدار', audience: 'أصحاب المشاريع الصغيرة', promise: 'وضوح يسهّل الخطوة التالية', tone: 'واضح' },
    palette: 'blue'
  },
  'idea-product-brief': {
    fields: { name: 'بوابة طلبات محلية', problem: 'تصل طلبات العملاء من أماكن متعددة ويصعب تتبعها.', users: 'العميل، مسؤول الطلبات، المدير', scope: 'إرسال طلب، متابعة حالة، إشعار بالتحديث', constraints: 'نسخة أولية للويب، العربية والإنجليزية' },
    criteria: [
      { id: 'req-1', text: 'يستطيع العميل إرسال طلب بالحقول المطلوبة.' },
      { id: 'req-2', text: 'تظهر حالة الطلب الحالية بوضوح للمصرح لهم.' }
    ]
  },
  'idea-growth-loop': {
    fields: { audience: 'أصحاب المتاجر المحلية', objective: 'زيادة الوعي بخدمة الطلب الإلكتروني', message: 'نظّم طلباتك من مكان واحد', metric: 'زيارات صفحة الخدمة ثم الاستفسارات المؤكدة', window: 'أربعة أسابيع' },
    channels: ['محتوى تعليمي', 'رسائل للعملاء الحاليين', 'تعاون محلي']
  },
  'idea-capstone': {
    fields: { title: 'منصة تبادل الكتب الجامعية', question: 'كيف يمكن تسهيل العثور على كتاب مستعمل داخل الحرم؟' },
    milestones: [
      { id: 'cap-1', title: 'تحديد المشكلة ومراجعة المصادر', date: 'الأسبوع 1–2', deliverable: 'ملخص نطاق البحث', done: true },
      { id: 'cap-2', title: 'جمع المتطلبات ومقابلات افتراضية', date: 'الأسبوع 3–4', deliverable: 'قائمة احتياجات أولية', done: false },
      { id: 'cap-3', title: 'تصميم نموذج أولي واختباره', date: 'الأسبوع 5–7', deliverable: 'نموذج وتجربة استخدام', done: false },
      { id: 'cap-4', title: 'التوثيق والعرض النهائي', date: 'الأسبوع 8', deliverable: 'تقرير وعرض', done: false }
    ]
  },
  'idea-scale-map': {
    fields: { northStar: 'نسبة المستخدمين الذين يعودون أسبوعياً', constraint: 'وقت محدود لفريق الدعم' },
    roadmap: [
      { id: 'road-1', title: 'تحسين تجربة التسجيل', stage: 'now', priority: 'مرتفع', signal: 'إكمال التسجيل', done: false },
      { id: 'road-2', title: 'إضافة مركز مساعدة', stage: 'next', priority: 'متوسط', signal: 'انخفاض الأسئلة المتكررة', done: false },
      { id: 'road-3', title: 'توسيع التقارير', stage: 'later', priority: 'منخفض', signal: 'استخدام التقرير شهرياً', done: false }
    ]
  }
};

const labels = {
  save: ['حفظ المسودة','Save draft'], export: ['تصدير JSON','Export JSON'], reset: ['إعادة ضبط','Reset'],
  saved: ['حُفظت المسودة في جلسة هذا التبويب.','Draft saved in this tab session.'],
  resetDone: ['أُعيدت تجربة هذه الأداة إلى بياناتها التوضيحية.','This tool has been reset to its sample data.'],
  exported: ['تم تنزيل ملف المسودة.','Draft file downloaded.'],
  fictional: ['بيانات توضيحية · لا تحفظ خارج هذا التبويب','Sample data · stays in this tab only'],
  fill: ['أكمل الحقول المطلوبة أولاً.','Complete the required fields first.'],
  add: ['إضافة','Add'], remove: ['حذف','Remove'], done: ['منجز','Done'], pending: ['لم ينجز','Open'],
  empty: ['أضف عنصراً لبدء التخطيط.','Add an item to start planning.'],
  print: ['طباعة العرض','Print view'],
};

function t(h, pair) { return h.tx(pair[0], pair[1]); }
function e(h, value) { return h.esc(String(value ?? '')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function seedFor(id) {
  return { version: 1, ...(clone(initial[id] || {})), savedAt: null };
}

function readState(id) {
  const fallback = seedFor(id);
  try {
    const raw = sessionStorage.getItem(PREFIX + id);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 ? { ...fallback, ...parsed } : fallback;
  } catch { return fallback; }
}

function writeState(id, state) {
  try { state.savedAt = new Date().toISOString(); sessionStorage.setItem(PREFIX + id, JSON.stringify(state)); } catch {}
}

function button(h, action, label, cls = '') {
  return `<button type="button" class="${cls}" data-idea-action="${action}">${t(h, label)}</button>`;
}

function textField(h, name, label, value, opts = {}) {
  const type = opts.type || 'text';
  const attrs = `${opts.min !== undefined ? ` min="${opts.min}"` : ''}${opts.max !== undefined ? ` max="${opts.max}"` : ''}${opts.step ? ` step="${opts.step}"` : ''}${opts.required ? ' required' : ''}${opts.placeholder ? ` placeholder="${e(h, opts.placeholder)}"` : ''}`;
  return `<label class="idea-field ${opts.wide ? 'wide' : ''}"><span>${t(h, label)}</span><input type="${type}" name="${name}" data-idea-field="${name}" value="${e(h, value)}"${attrs}></label>`;
}

function textArea(h, name, label, value, rows = 3, wide = false) {
  return `<label class="idea-field ${wide ? 'wide' : ''}"><span>${t(h, label)}</span><textarea name="${name}" data-idea-field="${name}" rows="${rows}">${e(h, value)}</textarea></label>`;
}

function wrap(h, item, state, body) {
  const lang = h.lang();
  const meta = copy[item.id];
  return `<section class="zfx-idea-demo zfx-idea-${item.kind}" data-idea-demo="${e(h, item.id)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
    <header class="idea-tool-head"><div class="idea-wordmark"><span class="idea-mark">Z</span><span><b>FIELDNOTES</b><small>IDEA TO ACTION / LOCAL DEMO</small></span></div>
      <div class="idea-head-actions"><span class="idea-local-badge"><i></i>${t(h, labels.fictional)}</span>${button(h, 'reset', labels.reset)}${button(h, 'export', labels.export, 'idea-accent-button')}</div>
    </header>
    <div class="idea-tool-intro"><div><small>${t(h, meta.eyebrow)}</small><h2>${t(h, meta.title)}</h2><p>${t(h, meta.intro)}</p></div><div class="idea-index"><span>ZEZO / FORGE</span><b>✳</b><small>${e(h, item.id.toUpperCase())}</small></div></div>
    <main class="idea-workspace">${body}</main>
    <footer class="idea-tool-foot"><span>${t(h, ['هذه معاينة مستقلة. لا تُرسل بياناتها إلى ZEZO أو لأي خدمة خارجية.','This is an isolated preview. Its data is not sent to ZEZO or any external service.'])}</span><span>SESSION ONLY · ${e(h, item.kind.toUpperCase())}</span></footer>
  </section>`;
}

function feasibility(h, s) {
  const f = s.fields;
  const sales = Math.max(0, Number(f.monthlyCustomers) || 0);
  const price = Math.max(0, Number(f.averageSale) || 0);
  const variable = Math.max(0, Number(f.variableCost) || 0);
  const fixed = Math.max(0, Number(f.fixedCosts) || 0);
  const revenue = sales * price;
  const contribution = price - variable;
  const profit = revenue - sales * variable - fixed;
  const breakeven = contribution > 0 ? Math.ceil(fixed / contribution) : null;
  return `<div class="feasibility-layout"><form class="idea-panel assumption-panel" data-idea-form="save"><header><small>01 / ${t(h, ['الافتراضات','ASSUMPTIONS'])}</small><span>EDIT</span></header>
      ${textField(h, 'concept', ['اسم الفكرة','Idea name'], f.concept, {wide:true})}
      ${textField(h, 'monthlyCustomers', ['عدد المبيعات أو العملاء شهرياً','Sales or customers per month'], f.monthlyCustomers, {type:'number',min:0,max:1000000})}
      ${textField(h, 'averageSale', ['متوسط قيمة البيع','Average sale value'], f.averageSale, {type:'number',min:0,max:1000000,step:'0.01'})}
      ${textField(h, 'variableCost', ['التكلفة المتغيرة لكل بيع','Variable cost per sale'], f.variableCost, {type:'number',min:0,max:1000000,step:'0.01'})}
      ${textField(h, 'fixedCosts', ['التكاليف الثابتة الشهرية','Monthly fixed costs'], f.fixedCosts, {type:'number',min:0,max:100000000,step:'0.01'})}
      <div class="idea-form-actions">${button(h,'save',labels.save,'idea-accent-button')}</div>
    </form><section class="idea-panel result-panel"><header><small>02 / ${t(h, ['قراءة أولية','FIRST LOOK'])}</small><span>CALC / LOCAL</span></header>
      <div class="feasibility-lead"><small>${t(h, ['إيراد افتراضي بحسب مدخلاتك','Illustrative revenue from your inputs'])}</small><b data-calc="revenue">${h.money(revenue)}</b><span>${t(h, ['المبيعات الشهرية × متوسط البيع','Monthly sales × average sale'])}</span></div>
      <div class="feasibility-metrics"><article><small>${t(h, ['نقطة التعادل التقريبية','Approx. break-even'])}</small><b data-calc="breakeven">${breakeven === null ? '—' : `${breakeven} ${t(h,['بيعاً','sales'])}`}</b><span>${t(h, ['بيع يغطي التكاليف الثابتة','Sales to cover fixed costs'])}</span></article><article><small>${t(h, ['الفرق الشهري التوضيحي','Illustrative monthly difference'])}</small><b data-calc="profit" class="${profit < 0 ? 'negative' : ''}">${h.money(profit)}</b><span>${t(h, ['قبل الضرائب وأي بنود أخرى','Before taxes and other items'])}</span></article></div>
      <div class="assumption-note"><i>i</i><p>${t(h, ['هذا حساب مبسط يعتمد حصراً على الأرقام التي أدخلتها. لم تُضف نسب نمو أو بيانات سوق. راجع التكاليف والضرائب والالتزامات مع مختص قبل اتخاذ قرار.','This simple calculation only uses your inputs. No growth rates or market data are added. Review costs, taxes, and obligations with a qualified adviser before deciding.'])}</p></div>
    </section></div>`;
}

function canvas(h, s) {
  const blocks = [
    ['segments',['شرائح العملاء','Customer segments']], ['value',['القيمة المقترحة','Value proposition']], ['channels',['القنوات','Channels']],
    ['relationships',['علاقة العملاء','Customer relationships']], ['revenue',['مصادر الإيرادات','Revenue streams']], ['resources',['الموارد الرئيسية','Key resources']],
    ['activities',['الأنشطة الرئيسية','Key activities']], ['partners',['الشركاء','Key partners']], ['costs',['هيكل التكاليف','Cost structure']]
  ];
  return `<div class="canvas-toolbar"><span>${t(h,['نموذج العمل · لوحة عمل','BUSINESS MODEL · WORK CANVAS'])}</span><span>${t(h,['تسع مربعات، مسودة واحدة','Nine blocks · one working draft'])}</span>${button(h,'save',labels.save,'idea-accent-button')}</div><form class="canvas-grid" data-idea-form="save">${blocks.map(([key,label],i)=>`<label class="canvas-block block-${i+1}"><span class="canvas-block-index">${String(i+1).padStart(2,'0')}</span><b>${t(h,label)}</b><textarea data-idea-field="${key}" name="${key}" rows="5" aria-label="${t(h,label)}">${e(h,s.fields[key])}</textarea><small>${t(h,['اكتب فرضية أولية يمكن مراجعتها.','Write a first assumption you can review.'])}</small></label>`).join('')}</form>`;
}

function deck(h, s) {
  const slides = s.slides || initial['idea-investor-deck'].slides;
  const slide = slides[Math.max(0, Math.min(slides.length - 1, s.index || 0))];
  const index = Math.max(0, Math.min(slides.length - 1, s.index || 0));
  return `<div class="deck-layout"><aside class="deck-rail"><small>STORY / ${String(index+1).padStart(2,'0')} OF ${String(slides.length).padStart(2,'0')}</small><div class="deck-nav">${slides.map((x,i)=>`<button type="button" class="${i===index?'active':''}" data-idea-action="slide" data-index="${i}"><span>${String(i+1).padStart(2,'0')}</span><b>${e(h,x.title)}</b></button>`).join('')}</div><label class="idea-field"><span>${t(h,['اسم المشروع','Project name'])}</span><input data-idea-field="venture" value="${e(h,s.fields.venture)}"></label>${button(h,'print',labels.print)}</aside><article class="deck-stage"><div class="pitch-slide"><span class="pitch-kicker">${e(h,s.fields.venture||'PROJECT NAME')}</span><small>${String(index+1).padStart(2,'0')} / 06</small><h3>${e(h,slide.title)}</h3><textarea data-idea-slide-body rows="5" aria-label="${e(h,slide.title)}">${e(h,slide.body)}</textarea><div class="slide-footer"><span>STORY / ZEZO FORGE DEMO</span><span>${String(index+1).padStart(2,'0')}</span></div></div><div class="deck-controls">${button(h,'previous',['← الشريحة السابقة','← Previous slide'])}<span>${index+1} / ${slides.length}</span>${button(h,'next',['الشريحة التالية →','Next slide →'],'idea-accent-button')}</div><p class="deck-note">${t(h,['نص إرشادي قابل للتحرير. لا يحتوي على نتائج أو أرقام استثمارية مفترضة.','Editable prompt copy. No assumed results or investment figures are included.'])}</p></article></div>`;
}

function mvp(h, s) {
  const features = s.features || [];
  const must = features.filter(x=>x.priority==='must').length;
  return `<div class="mvp-layout"><section class="idea-panel mvp-brief"><header><small>01 / ${t(h,['من نساعد؟','WHO IS IT FOR?'])}</small><span>DEFINE</span></header>${textArea(h,'user',['المستخدم الأول','First user'],s.fields.user,2)}${textArea(h,'problem',['المشكلة','Problem'],s.fields.problem,3)}${textField(h,'outcome',['إشارة النجاح','Success signal'],s.fields.outcome,{wide:true})}<div class="mvp-count"><b>${must}</b><span>${t(h,['ميزة أساسية في النطاق','Must-have feature(s) in scope'])}</span></div></section><section class="idea-panel feature-panel"><header><small>02 / ${t(h,['خريطة الميزات','FEATURE MAP'])}</small><span>${features.length} ${t(h,['عناصر','ITEMS'])}</span></header><div class="priority-legend"><span class="priority-must">${t(h,['أساسي','MUST'])}</span><span class="priority-later">${t(h,['لاحقاً','LATER'])}</span></div><div class="feature-list">${features.map((f,i)=>`<article class="feature-row ${f.checked?'checked':''}"><span class="feature-grip">${String(i+1).padStart(2,'0')}</span><input data-feature-text="${e(h,f.id)}" value="${e(h,f.text)}" aria-label="${t(h,['اسم الميزة','Feature name'])}"><select data-feature-priority="${e(h,f.id)}" aria-label="${t(h,['أولوية الميزة','Feature priority'])}"><option value="must" ${f.priority==='must'?'selected':''}>${t(h,['أساسي','Must'])}</option><option value="later" ${f.priority==='later'?'selected':''}>${t(h,['لاحقاً','Later'])}</option></select><button type="button" data-idea-action="feature-check" data-id="${e(h,f.id)}" aria-pressed="${Boolean(f.checked)}">${f.checked?'✓':'○'}</button><button type="button" data-idea-action="feature-remove" data-id="${e(h,f.id)}" aria-label="${t(h,labels.remove)}">×</button></article>`).join('') || `<p class="idea-empty">${t(h,labels.empty)}</p>`}</div><form class="idea-add-row" data-idea-form="add-feature"><input name="feature" required maxlength="90" placeholder="${t(h,['أضف ميزة مقترحة','Add a feature'])}"><button class="idea-accent-button">${t(h,labels.add)} ＋</button></form><div class="mvp-rule"><b>${t(h,['قاعدة النطاق','SCOPE RULE'])}</b><p>${t(h,['ابدأ بما يختبر قيمة الحل؛ أبقِ التحسينات غير الضرورية خارج أول إصدار.','Start with what tests the solution’s value; keep nonessential enhancements out of the first release.'])}</p></div></section></div>`;
}

function launch(h, s) {
  const tasks = s.tasks || [];
  const done = tasks.filter(x=>x.done).length;
  const progress = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  return `<section class="idea-panel launch-board"><header><div><small>LAUNCH PLAN / ${t(h,['قائمة التنفيذ','ACTION LIST'])}</small><h3>${t(h,['الخطة تتحرك مع إنجازك.','The plan moves as you make progress.'])}</h3></div><b class="launch-progress-number">${progress}%</b></header><div class="launch-progress"><span style="width:${progress}%"></span></div><div class="launch-columns">${['قبل الإطلاق','يوم الإطلاق','بعد الإطلاق'].map((phase,pi)=>`<section class="launch-phase"><header><b>0${pi+1}</b><span>${t(h,[phase,['Before launch','Launch day','After launch'][pi]])}</span><small>${tasks.filter(x=>x.phase===phase).length}</small></header>${tasks.filter(x=>x.phase===phase).map(task=>`<article class="launch-task ${task.done?'done':''}"><button type="button" data-idea-action="task-check" data-id="${e(h,task.id)}" aria-pressed="${Boolean(task.done)}">${task.done?'✓':''}</button><div><b>${e(h,task.title)}</b><small>${e(h,task.week)} · ${t(h,['المسؤول:','Owner:'])} ${e(h,task.owner)}</small></div><button type="button" class="remove-task" data-idea-action="task-remove" data-id="${e(h,task.id)}" aria-label="${t(h,labels.remove)}">×</button></article>`).join('')}</section>`)}</div><form class="launch-add-form" data-idea-form="add-launch"><input name="title" required maxlength="90" placeholder="${t(h,['مهمة جديدة','Add a launch task'])}"><select name="phase" aria-label="${t(h,['مرحلة التنفيذ','Launch phase'])}"><option value="قبل الإطلاق">${t(h,['قبل الإطلاق','Before launch'])}</option><option value="يوم الإطلاق">${t(h,['يوم الإطلاق','Launch day'])}</option><option value="بعد الإطلاق">${t(h,['بعد الإطلاق','After launch'])}</option></select><input name="week" maxlength="32" placeholder="${t(h,['موعد نسبي','Relative timing'])}"><input name="owner" maxlength="40" placeholder="${t(h,['المسؤول','Owner'])}"><button class="idea-accent-button">${t(h,labels.add)} ＋</button></form></section>`;
}

const palettes = {
  blue: { label:['أزرق عميق','Deep blue'], bg:'#08131e', surface:'#102537', accent:'#37b9ee', ink:'#eff7fb', glow:'rgba(55,185,238,.22)' },
  lime: { label:['ليموني وحيوي','Lime energy'], bg:'#10160d', surface:'#202b17', accent:'#a3ff12', ink:'#f5f8ed', glow:'rgba(163,255,18,.18)' },
  rose: { label:['وردي هادئ','Soft rose'], bg:'#1a1017', surface:'#2c1a27', accent:'#f2a2bd', ink:'#fff2f7', glow:'rgba(242,162,189,.18)' },
  clay: { label:['طيني دافئ','Warm clay'], bg:'#1b1510', surface:'#30251b', accent:'#d19a69', ink:'#fff6eb', glow:'rgba(209,154,105,.2)' }
};

function brand(h, s) {
  const p = palettes[s.palette] || palettes.blue;
  return `<div class="brand-studio-layout"><section class="idea-panel brand-controls"><header><small>BRAND / BUILD YOUR DIRECTION</small><span>EDITABLE</span></header>${textField(h,'name',['اسم العلامة','Brand name'],s.fields.name,{wide:true})}${textField(h,'audience',['الجمهور المقصود','Intended audience'],s.fields.audience,{wide:true})}${textField(h,'promise',['الوعد أو القيمة','Brand promise'],s.fields.promise,{wide:true})}<label class="idea-field"><span>${t(h,['نبرة العلامة','Brand voice'])}</span><select data-idea-field="tone" name="tone"><option value="واضح" ${s.fields.tone==='واضح'?'selected':''}>${t(h,['واضح','Clear'])}</option><option value="ودود" ${s.fields.tone==='ودود'?'selected':''}>${t(h,['ودود','Warm'])}</option><option value="جريء" ${s.fields.tone==='جريء'?'selected':''}>${t(h,['جريء','Bold'])}</option></select></label><div class="palette-picker"><small>${t(h,['اختر اتجاهاً لونياً','Choose a color direction'])}</small>${Object.entries(palettes).map(([key,pal])=>`<button type="button" data-idea-action="palette" data-palette="${key}" class="${s.palette===key?'selected':''}" aria-pressed="${s.palette===key}"><i style="--swatch:${pal.accent}"></i><span>${t(h,pal.label)}</span></button>`).join('')}</div></section><section class="brand-preview" style="--brand-bg:${p.bg};--brand-surface:${p.surface};--brand-accent:${p.accent};--brand-ink:${p.ink};--brand-glow:${p.glow}"><div class="brand-preview-top"><span>IDENTITY / 01</span><span>PREVIEW ONLY</span></div><div class="brand-orb">${e(h,(s.fields.name||'ZE').slice(0,2))}</div><small>${e(h,s.fields.audience||'AUDIENCE')}</small><h3>${e(h,s.fields.name||'اسم العلامة')}</h3><p>${e(h,s.fields.promise||'قيمة المشروع')}</p><span class="brand-tone-chip">${t(h,['النبرة:','Voice:'])} ${e(h,s.fields.tone||'واضح')}</span><div class="brand-swatches">${[p.accent,p.surface,p.ink].map(c=>`<span style="--swatch:${c}"><i></i><small>${e(h,c)}</small></span>`).join('')}</div><footer>BRAND CONCEPT / ${e(h, s.palette.toUpperCase())}</footer></section></div>`;
}

function brief(h, s) {
  const criteria = s.criteria || [];
  return `<div class="brief-layout"><form class="idea-panel product-brief-form" data-idea-form="save"><header><small>PRODUCT BRIEF / V1</small><span>WORKING DRAFT</span></header>${textField(h,'name',['اسم المنتج أو المشروع','Product or project name'],s.fields.name,{wide:true,required:true})}${textArea(h,'problem',['المشكلة والهدف','Problem and goal'],s.fields.problem,3,true)}${textArea(h,'users',['أنواع المستخدمين','User roles'],s.fields.users,2,true)}${textArea(h,'scope',['النطاق المتوقع','Expected scope'],s.fields.scope,3,true)}${textArea(h,'constraints',['القيود والافتراضات','Constraints and assumptions'],s.fields.constraints,2,true)}<div class="idea-form-actions">${button(h,'save',labels.save,'idea-accent-button')}${button(h,'print',labels.print)}</div></form><section class="idea-panel acceptance-panel"><header><small>ACCEPTANCE / CHECKLIST</small><span>${criteria.length.toString().padStart(2,'0')}</span></header><h3>${t(h,['معايير القبول','Acceptance criteria'])}</h3><p>${t(h,['كيف نعرف أن هذه الوظيفة جاهزة؟','How will we know this is ready?'])}</p><div class="criteria-list">${criteria.map((c,i)=>`<article><span>${String(i+1).padStart(2,'0')}</span><input data-criteria-text="${e(h,c.id)}" value="${e(h,c.text)}" aria-label="${t(h,['معيار القبول','Acceptance criterion'])}"><button type="button" data-idea-action="criteria-remove" data-id="${e(h,c.id)}" aria-label="${t(h,labels.remove)}">×</button></article>`).join('')}</div><form class="idea-add-row" data-idea-form="add-criterion"><input name="criterion" required maxlength="140" placeholder="${t(h,['معيار قابل للتحقق','Measurable acceptance criterion'])}"><button class="idea-accent-button">${t(h,labels.add)} ＋</button></form><div class="brief-safety">${t(h,['وثيقة توضيحية. لا تتضمن مواصفات أمنية أو تقنية معتمدة حتى يراجعها الفريق.','Sample brief. Security and technical requirements still need team review.'])}</div></section></div>`;
}

function growth(h, s) {
  const f=s.fields, channels=s.channels||[];
  return `<div class="growth-layout"><form class="idea-panel campaign-form" data-idea-form="save"><header><small>CAMPAIGN / STRATEGY</small><span>PLAN · MEASURE</span></header>${textField(h,'audience',['الجمهور','Audience'],f.audience,{wide:true})}${textField(h,'objective',['هدف الحملة','Campaign objective'],f.objective,{wide:true})}${textArea(h,'message',['الرسالة الرئيسية','Core message'],f.message,3,true)}${textField(h,'metric',['مؤشر القياس','Measurement signal'],f.metric,{wide:true})}${textField(h,'window',['مدة التخطيط','Planning window'],f.window,{wide:true})}<div class="idea-form-actions">${button(h,'save',labels.save,'idea-accent-button')}${button(h,'export',labels.export)}</div></form><section class="idea-panel channel-board"><header><small>CHANNEL MIX / REVIEW</small><span>${channels.length.toString().padStart(2,'0')} OPTIONS</span></header><h3>${t(h,['اختَر القنوات التي تناسب جمهورك.','Select channels that fit your audience.'])}</h3><p>${t(h,['اختيار القناة لا ينشئ حملة ولا ينفق ميزانية.','Selecting a channel does not launch a campaign or spend budget.'])}</p><div>${channels.map((name,i)=>`<label class="channel-choice"><input type="checkbox" data-channel="${i}" ${s.selected?.includes(i)?'checked':''}><span class="channel-icon">${['◉','↗','✳'][i%3]}</span><span><b>${t(h,[name,['Educational content','Customer email','Local partnership'][i]])}</b><small>${t(h,['خطة محتوى ومثال توضيحي','Content outline and sample idea'])}</small></span><i></i></label>`).join('')}</div><aside><small>${t(h,['مبدأ القياس','MEASUREMENT NOTE'])}</small><b>${e(h,f.metric)}</b><span>${t(h,['اجمع بيانات بموافقة المستخدم، وحدد خط أساس قبل مقارنة النتائج.','Collect consent-based data and define a baseline before comparing results.'])}</span></aside></section></div>`;
}

function capstone(h, s) {
  const rows=s.milestones||[];const done=rows.filter(x=>x.done).length;const progress=rows.length?Math.round(done/rows.length*100):0;
  return `<section class="capstone-board"><header><div><small>CAPSTONE / DELIVERY TRACK</small><h3>${e(h,s.fields.title)}</h3><p>${e(h,s.fields.question)}</p></div><div class="capstone-progress"><b>${progress}%</b><span>${t(h,['منجز','complete'])}</span></div></header><div class="capstone-track"><div class="capstone-track-line"><span style="width:${progress}%;--progress-height:${progress}%"></span></div>${rows.map((m,i)=>`<article class="milestone ${m.done?'done':''}"><button type="button" data-idea-action="milestone-check" data-id="${e(h,m.id)}" aria-pressed="${Boolean(m.done)}"><span>${m.done?'✓':String(i+1).padStart(2,'0')}</span></button><div class="milestone-card"><small>${e(h,m.date)}</small><h4>${e(h,m.title)}</h4><p>${t(h,['المخرج:','Deliverable:'])} ${e(h,m.deliverable)}</p><button type="button" data-idea-action="milestone-remove" data-id="${e(h,m.id)}">${t(h,labels.remove)} ×</button></div></article>`)}</div><form class="capstone-add" data-idea-form="add-milestone"><input name="title" required maxlength="80" placeholder="${t(h,['مرحلة جديدة','New milestone'])}"><input name="date" maxlength="30" placeholder="${t(h,['المدة أو الأسبوع','Duration / week'])}"><input name="deliverable" maxlength="80" placeholder="${t(h,['المخرج المتوقع','Expected deliverable'])}"><button class="idea-accent-button">${t(h,labels.add)} ＋</button></form><label class="idea-field capstone-project-name"><span>${t(h,['سؤال المشروع','Project question'])}</span><input data-idea-field="question" value="${e(h,s.fields.question)}"></label></section>`;
}

function roadmap(h,s) {
  const cols=[['now',['الآن','NOW']],['next',['التالي','NEXT']],['later',['لاحقاً','LATER']]];
  const cards=s.roadmap||[];
  return `<div class="roadmap-layout"><section class="roadmap-context"><small>PRODUCT NORTH STAR</small><label class="idea-field"><span>${t(h,['إشارة النجاح الأساسية','North-star signal'])}</span><input data-idea-field="northStar" value="${e(h,s.fields.northStar)}"></label><label class="idea-field"><span>${t(h,['قيد أو تحدٍ حالي','Current constraint'])}</span><input data-idea-field="constraint" value="${e(h,s.fields.constraint)}"></label><p>${t(h,['اربط كل مبادرة بهدف أو إشارة يمكن مراجعتها. لا تمثل هذه الخريطة وعداً بموعد إطلاق.','Connect each initiative to a goal or observable signal. This roadmap does not promise a release date.'])}</p></section><div class="roadmap-columns">${cols.map(([key,label])=>`<section class="roadmap-column column-${key}"><header><span>${t(h,label)}</span><b>${cards.filter(x=>x.stage===key).length.toString().padStart(2,'0')}</b></header>${cards.filter(x=>x.stage===key).map(card=>`<article class="roadmap-card"><div><span class="road-priority priority-${card.priority==='مرتفع'?'high':card.priority==='منخفض'?'low':'mid'}">${t(h,[card.priority,card.priority==='مرتفع'?'High':card.priority==='منخفض'?'Low':'Medium'])}</span><button type="button" data-idea-action="road-remove" data-id="${e(h,card.id)}" aria-label="${t(h,labels.remove)}">×</button></div><h4>${e(h,card.title)}</h4><small>${t(h,['إشارة:','Signal:'])} ${e(h,card.signal)}</small><label class="road-stage"><span>${t(h,['نقل إلى','Move to'])}</span><select data-road-stage="${e(h,card.id)}"><option value="now" ${card.stage==='now'?'selected':''}>${t(h,['الآن','Now'])}</option><option value="next" ${card.stage==='next'?'selected':''}>${t(h,['التالي','Next'])}</option><option value="later" ${card.stage==='later'?'selected':''}>${t(h,['لاحقاً','Later'])}</option></select></label></article>`).join('')||`<p class="road-empty">${t(h,labels.empty)}</p>`}</section>`).join('')}</div><form class="roadmap-add" data-idea-form="add-road"><input name="title" required maxlength="80" placeholder="${t(h,['مبادرة جديدة','New initiative'])}"><input name="signal" maxlength="80" placeholder="${t(h,['إشارة النجاح','Success signal'])}"><select name="priority"><option value="مرتفع">${t(h,['مرتفع','High'])}</option><option value="متوسط" selected>${t(h,['متوسط','Medium'])}</option><option value="منخفض">${t(h,['منخفض','Low'])}</option></select><button class="idea-accent-button">${t(h,labels.add)} ＋</button></form></div>`;
}

function renderBody(h, item, s) {
  switch(item.id) {
    case 'idea-venture-check': return feasibility(h,s);
    case 'idea-business-canvas': return canvas(h,s);
    case 'idea-investor-deck': return deck(h,s);
    case 'idea-mvp-map': return mvp(h,s);
    case 'idea-launch-sequence': return launch(h,s);
    case 'idea-mark-studio': return brand(h,s);
    case 'idea-product-brief': return brief(h,s);
    case 'idea-growth-loop': return growth(h,s);
    case 'idea-capstone': return capstone(h,s);
    case 'idea-scale-map': return roadmap(h,s);
    default: return '';
  }
}

export function renderIdeasDemo(item, helpers) {
  if (!item || !ids.includes(item.id)) return '';
  const state=readState(item.id);
  return wrap(helpers,item,state,renderBody(helpers,item,state));
}

function downloadDraft(item, state) {
  const blob = new Blob([JSON.stringify({ tool:item.id, title:item.title?.en || item.id, savedAt:state.savedAt, draft:state }, null, 2)], { type:'application/json' });
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${item.id}-draft.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);
}

function update(root,item,helpers,mutate,notify) {
  const s=readState(item.id);mutate(s);writeState(item.id,s);root.innerHTML=renderIdeasDemo(item,helpers);
  if(notify)helpers.notice(helpers.tx(notify[0],notify[1]));
}

function recomputeFeasibility(root, h) {
  const form=root.querySelector('[data-idea-form="save"]');if(!form)return;
  const data=Object.fromEntries(new FormData(form));
  const units=Math.max(0,Number(data.monthlyCustomers)||0),price=Math.max(0,Number(data.averageSale)||0),variable=Math.max(0,Number(data.variableCost)||0),fixed=Math.max(0,Number(data.fixedCosts)||0);
  const revenue=units*price,contribution=price-variable,profit=revenue-units*variable-fixed;
  const breakEven=contribution>0?`${Math.ceil(fixed/contribution)} ${h.tx('بيعاً','sales')}`:'—';
  const rev=root.querySelector('[data-calc="revenue"]'),be=root.querySelector('[data-calc="breakeven"]'),p=root.querySelector('[data-calc="profit"]');
  if(rev)rev.textContent=h.money(revenue);if(be)be.textContent=breakEven;if(p){p.textContent=h.money(profit);p.classList.toggle('negative',profit<0)}
}

export function mountIdeasDemo(root,item,helpers) {
  if(!root||!item||!ids.includes(item.id))return;
  const scope=()=>root.querySelector(`[data-idea-demo="${item.id}"]`);

  root.addEventListener('input',event=>{
    const target=event.target.closest('[data-idea-field], [data-idea-slide-body], [data-feature-text], [data-criteria-text]');if(!target||!scope()?.contains(target))return;
    const s=readState(item.id);
    if(target.matches('[data-idea-field]'))s.fields[target.dataset.ideaField]=target.value;
    else if(target.matches('[data-idea-slide-body]'))s.slides[s.index||0].body=target.value;
    else if(target.matches('[data-feature-text]')){const row=s.features.find(x=>x.id===target.dataset.featureText);if(row)row.text=target.value}
    else if(target.matches('[data-criteria-text]')){const row=s.criteria.find(x=>x.id===target.dataset.criteriaText);if(row)row.text=target.value}
    writeState(item.id,s);if(item.id==='idea-venture-check')recomputeFeasibility(root,helpers);
    if(item.id==='idea-mark-studio'){
      const card=scope()?.querySelector('.brand-preview');const p=palettes[s.palette]||palettes.blue;if(card){card.style.setProperty('--brand-bg',p.bg);card.style.setProperty('--brand-surface',p.surface);card.style.setProperty('--brand-accent',p.accent);card.style.setProperty('--brand-ink',p.ink);card.style.setProperty('--brand-glow',p.glow)}
      const map={name:'.brand-preview h3',audience:'.brand-preview>small',promise:'.brand-preview>p',tone:'.brand-tone-chip'};const el=scope()?.querySelector(map[target.dataset.ideaField]);if(el)el.textContent=target.value||'';
    }
    if(item.id==='idea-capstone'&&target.dataset.ideaField==='question'){const el=scope()?.querySelector('.capstone-board>header p');if(el)el.textContent=target.value}
    if(item.id==='idea-scale-map'&&target.dataset.ideaField==='northStar'){/* value is kept in the editable field */}
  });

  root.addEventListener('change',event=>{
    const target=event.target;if(!scope()?.contains(target))return;
    if(target.matches('[data-feature-priority]'))update(root,item,helpers,s=>{const row=s.features.find(x=>x.id===target.dataset.featurePriority);if(row)row.priority=target.value});
    else if(target.matches('[data-channel]'))update(root,item,helpers,s=>{s.selected||=[];const i=Number(target.dataset.channel);if(target.checked&&!s.selected.includes(i))s.selected.push(i);if(!target.checked)s.selected=s.selected.filter(x=>x!==i)});
    else if(target.matches('[data-road-stage]'))update(root,item,helpers,s=>{const row=s.roadmap.find(x=>x.id===target.dataset.roadStage);if(row)row.stage=target.value});
    else if(target.matches('[data-idea-field]')){const s=readState(item.id);s.fields[target.dataset.ideaField]=target.value;writeState(item.id,s)}
  });

  root.addEventListener('click',event=>{
    const btn=event.target.closest('[data-idea-action]');if(!btn||!scope()?.contains(btn))return;
    const action=btn.dataset.ideaAction;
    if(action==='reset'){
      try{sessionStorage.removeItem(PREFIX+item.id)}catch{}
      root.innerHTML=renderIdeasDemo(item,helpers);helpers.notice(helpers.tx(labels.resetDone[0],labels.resetDone[1]));return;
    }
    if(action==='export'){const s=readState(item.id);writeState(item.id,s);downloadDraft(item,s);helpers.notice(helpers.tx(labels.exported[0],labels.exported[1]));return}
    if(action==='save'){const s=readState(item.id);const form=scope()?.querySelector('[data-idea-form="save"]')||scope()?.querySelector('.product-brief-form')||scope()?.querySelector('.campaign-form')||scope()?.querySelector('.canvas-grid');if(form){for(const input of form.querySelectorAll('[data-idea-field]'))s.fields[input.dataset.ideaField]=input.value;if(item.id==='idea-investor-deck'){const body=scope()?.querySelector('[data-idea-slide-body]');if(body)s.slides[s.index||0].body=body.value}writeState(item.id,s)}helpers.notice(helpers.tx(labels.saved[0],labels.saved[1]));return}
    if(action==='print'){window.print();return}
    if(action==='previous'||action==='next'||action==='slide'){
      update(root,item,helpers,s=>{const total=s.slides?.length||6;if(action==='previous')s.index=Math.max(0,(s.index||0)-1);else if(action==='next')s.index=Math.min(total-1,(s.index||0)+1);else s.index=Math.max(0,Math.min(total-1,Number(btn.dataset.index)||0))});return;
    }
    if(action==='palette'){update(root,item,helpers,s=>s.palette=btn.dataset.palette);return}
    if(action==='feature-check')update(root,item,helpers,s=>{const row=s.features.find(x=>x.id===btn.dataset.id);if(row)row.checked=!row.checked});
    else if(action==='feature-remove')update(root,item,helpers,s=>s.features=s.features.filter(x=>x.id!==btn.dataset.id));
    else if(action==='task-check')update(root,item,helpers,s=>{const row=s.tasks.find(x=>x.id===btn.dataset.id);if(row)row.done=!row.done});
    else if(action==='task-remove')update(root,item,helpers,s=>s.tasks=s.tasks.filter(x=>x.id!==btn.dataset.id));
    else if(action==='criteria-remove')update(root,item,helpers,s=>s.criteria=s.criteria.filter(x=>x.id!==btn.dataset.id));
    else if(action==='milestone-check')update(root,item,helpers,s=>{const row=s.milestones.find(x=>x.id===btn.dataset.id);if(row)row.done=!row.done});
    else if(action==='milestone-remove')update(root,item,helpers,s=>s.milestones=s.milestones.filter(x=>x.id!==btn.dataset.id));
    else if(action==='road-remove')update(root,item,helpers,s=>s.roadmap=s.roadmap.filter(x=>x.id!==btn.dataset.id));
  });

  root.addEventListener('submit',event=>{
    const form=event.target.closest('[data-idea-form]');if(!form||!scope()?.contains(form))return;
    event.preventDefault();const data=Object.fromEntries(new FormData(form));
    switch(form.dataset.ideaForm){
      case 'save': {
        const s=readState(item.id);for(const input of form.querySelectorAll('[data-idea-field]'))s.fields[input.dataset.ideaField]=input.value;
        if(item.id==='idea-investor-deck'){const body=scope()?.querySelector('[data-idea-slide-body]');if(body)s.slides[s.index||0].body=body.value}
        writeState(item.id,s);helpers.notice(helpers.tx(labels.saved[0],labels.saved[1]));break;
      }
      case 'add-feature': update(root,item,helpers,s=>s.features.unshift({id:`mvp-${Date.now()}`,text:data.feature.trim(),priority:'must',checked:false}),['أُضيفت الميزة إلى الخريطة.','Feature added to the map.']);break;
      case 'add-launch': update(root,item,helpers,s=>s.tasks.push({id:`launch-${Date.now()}`,title:data.title.trim(),phase:data.phase,week:data.week.trim()||helpers.tx('موعد غير محدد','Unscheduled'),owner:data.owner.trim()||helpers.tx('غير محدد','Unassigned'),done:false}),['أُضيفت المهمة إلى خطة الإطلاق.','Task added to the launch plan.']);break;
      case 'add-criterion': update(root,item,helpers,s=>s.criteria.push({id:`req-${Date.now()}`,text:data.criterion.trim()}),['أُضيف معيار القبول.','Acceptance criterion added.']);break;
      case 'add-milestone': update(root,item,helpers,s=>s.milestones.push({id:`cap-${Date.now()}`,title:data.title.trim(),date:data.date.trim()||helpers.tx('لاحقاً','Later'),deliverable:data.deliverable.trim()||helpers.tx('يُحدد لاحقاً','To be defined'),done:false}),['أُضيفت مرحلة للمشروع.','Milestone added.']);break;
      case 'add-road': update(root,item,helpers,s=>s.roadmap.push({id:`road-${Date.now()}`,title:data.title.trim(),signal:data.signal.trim()||helpers.tx('يُحدد لاحقاً','To be defined'),priority:data.priority,stage:'now',done:false}),['أُضيفت مبادرة إلى «الآن».','Initiative added to “Now”.']);break;
    }
  });
}
