// 独立交互原型：语料为固定示例；没有翻译、解析或同步请求。
const paragraphs = [
  [
    { en: 'High above the city, on a tall column, stood the statue of the Happy Prince.', zh: '在城市的高处，一根高高的圆柱上，矗立着快乐王子的雕像。', parts: [['High above the city, on a tall column', '先交代地点：在城市高处的一根圆柱上。'], ['stood the statue of the Happy Prince', '地点提前，主语放到动词 stood 后面。按“快乐王子的雕像矗立着”理解即可。']], term: ['stood', 'stand 的过去式。这里表示“矗立”，不是一个站起来的动作。'] },
    { en: 'He was gilded all over with thin leaves of fine gold, for eyes he had two bright sapphires, and a large red ruby glowed on his sword-hilt.', zh: '他全身贴着薄薄的纯金箔，两颗明亮的蓝宝石是他的眼睛，一颗硕大的红宝石在剑柄上闪着光。', parts: [['He was gilded all over with thin leaves of fine gold', 'was gilded 是被动表达：全身被覆上金箔。leaves 在这里是薄片，不是树叶。'], ['for eyes he had two bright sapphires', '他用两颗蓝宝石作眼睛。for eyes 提前，是为了突出雕像的眼睛。'], ['a large red ruby glowed on his sword-hilt', '剑柄上，一颗硕大的红宝石闪着光。']], term: ['be gilded with', '表面覆上薄薄一层金。thin leaves of gold 就是薄金箔。'] }
  ],
  [
    { en: 'He was very much admired indeed.', zh: '他的确非常受人赞美。', parts: [['He was very much admired', '被动结构：人们非常赞美他。'], ['indeed', '加强语气：的确、确实如此。']], term: ['admire', '欣赏、赞美。这里用被动形式 admired，描述雕像受到赞赏。'] },
    { en: '“He is as beautiful as a weathercock,” remarked one of the Town Councillors who wished to gain a reputation for having artistic tastes; “only not quite so useful,” he added, fearing lest people should think him unpractical, which he really was not.', zh: '“他像风向标一样漂亮，”一位想以艺术品位博得名声的市议员评论说。“只是没有那么实用。”他又补充道，生怕人们觉得他不切实际——而他自认并非如此。', parts: [['one of the Town Councillors who wished to gain a reputation', '说话的是一位市议员，who 从句解释他想博得怎样的名声。'], ['for having artistic tastes', '想让大家觉得他有艺术鉴赏力。'], ['fearing lest people should think him unpractical', '补充那句话的原因：担心别人认为他不务实。'], ['which he really was not', '叙述者补上一笔：他确实不是那样。语气中带着讽刺。']], term: ['gain a reputation for', '因某种特质而获得名声。此处暗含议员想显得懂艺术的心思。'] }
  ],
  [
    { en: '“Why can’t you be like the Happy Prince?” asked a sensible mother of her little boy who was crying for the moon.', zh: '“你为什么不能像快乐王子那样呢？”一位明事理的母亲问她的小男孩。那孩子正在为不可能得到的东西哭闹。', parts: [['asked a sensible mother of her little boy', 'ask something of someone：母亲向孩子提出这个问题。'], ['who was crying for the moon', 'who 修饰小男孩。cry for the moon 是固定表达：想要根本得不到的东西。']], term: ['cry for the moon', '想要不可能得到的东西；痴心妄想。这里同时保留了孩子哭闹的画面。'] },
    { en: '“The Happy Prince never dreams of crying for anything.”', zh: '“快乐王子从来不会为任何东西哭闹。”', parts: [['never dreams of', '根本不会想到。后面接动名词。'], ['crying for anything', '为想要什么而哭闹。']], term: ['dream of doing', '想到做某事，也可以表示梦想做某事。这里由 never 表达“想都不会想”。'] }
  ],
  [
    { en: '“I am glad there is someone in the world who is quite happy,” muttered a disappointed man as he gazed at the wonderful statue.', zh: '“世上总算还有一个完全快乐的人，我很高兴。”一个失意的人凝视着那尊精美的雕像，低声说道。', parts: [['someone in the world who is quite happy', 'who 修饰 someone：世界上有一个完全快乐的人。'], ['muttered a disappointed man', '又一次把说话者放到动词后面：一个失意的人低声说。'], ['as he gazed at the wonderful statue', 'as 在这里表示同时发生：他一边凝视雕像，一边低声说。']], term: ['gaze at', '凝视，久久注视。比 look at 更强调目光停留。'] }
  ],
  [
    { en: '“He looks just like an angel,” said the Charity Children as they came out of the cathedral in their bright scarlet cloaks and their clean white pinafores.', zh: '“他看起来就像一位天使。”慈善学校的孩子们说。他们穿着鲜红的斗篷和洁白的围裙，从大教堂里走出来。', parts: [['He looks just like an angel', 'just like：看起来简直就像。'], ['as they came out of the cathedral', '交代说话的时刻：他们正从大教堂出来。'], ['in their bright scarlet cloaks and their clean white pinafores', 'in 后面接衣服，描述他们穿着什么。']], term: ['scarlet', '鲜红色。这里和洁白的围裙构成鲜明的色彩对照。'] },
    { en: '“How do you know?” said the Mathematical Master, “you have never seen one.”', zh: '“你们怎么知道？”数学老师说，“你们从来没有见过天使。”', parts: [['you have never seen one', '现在完成时：到现在为止从来没见过。one 指代前面提到的 angel。']], term: ['one', '代替前文出现的可数名词，避免重复。这里指 angel。'] }
  ],
  [
    { en: '“Ah! but we have, in our dreams,” answered the children; and the Mathematical Master frowned and looked very severe, for he did not approve of children dreaming.', zh: '“啊！可我们见过，在梦里见过。”孩子们回答。数学老师皱起眉头，神情严厉，因为他不赞成孩子们做梦。', parts: [['but we have, in our dreams', 'we have 省略了 seen one，接住老师前一句的现在完成时。'], ['for he did not approve of children dreaming', 'for 说明原因。approve of 表示赞成，后面接名词或动名词。']], term: ['approve of', '赞成、认可。注意介词 of，后面可以接 doing。'] }
  ]
];

const vocabulary = {
  high: ['adv.', '在高处'], above: ['prep.', '在……上方'], city: ['n.', '城市'], tall: ['adj.', '高的'], column: ['n.', '圆柱；柱子'], statue: ['n.', '雕像'], happy: ['adj.', '快乐的'], prince: ['n.', '王子'], gilded: ['v.', '镀金；覆上金箔', '/ˈɡɪldɪd/'], thin: ['adj.', '薄的'], leaves: ['n.', '薄片；此处指金箔'], fine: ['adj.', '纯的；优质的'], gold: ['n.', '金子'], bright: ['adj.', '明亮的'], sapphires: ['n.', '蓝宝石'], ruby: ['n.', '红宝石'], glowed: ['v.', '发出柔和的光'], 'sword-hilt': ['n.', '剑柄'], admired: ['v.', '受到欣赏；受人赞美'], indeed: ['adv.', '的确；确实'], weathercock: ['n.', '风向标（常做成公鸡形状）'], remarked: ['v.', '评论说；说道'], councillors: ['n.', '市议员'], reputation: ['n.', '名声；声誉'], artistic: ['adj.', '艺术的'], tastes: ['n.', '鉴赏力；品位'], useful: ['adj.', '有用的；实用的'], fearing: ['v.', '担心；害怕'], lest: ['conj.', '以免；唯恐'], unpractical: ['adj.', '不切实际的'], sensible: ['adj.', '明事理的；理智的'], crying: ['v.', '哭泣；哭闹'], moon: ['n.', '月亮'], dreams: ['n. / v.', '梦；想到'], muttered: ['v.', '低声说；咕哝'], disappointed: ['adj.', '失意的；失望的'], gazed: ['v.', '凝视'], wonderful: ['adj.', '精美的；令人惊叹的'], angel: ['n.', '天使'], charity: ['n.', '慈善'], cathedral: ['n.', '大教堂'], scarlet: ['adj.', '鲜红色的'], cloaks: ['n.', '斗篷'], pinafores: ['n.', '围裙'], mathematical: ['adj.', '数学的'], frowned: ['v.', '皱眉'], severe: ['adj.', '严厉的'], approve: ['v.', '赞成；认可'], dreaming: ['v.', '做梦'], 'crying for the moon': ['idiom', '想要不可能得到的东西'], 'gain a reputation': ['phrase', '获得名声'], 'gazed at': ['phrase', '凝视'], 'approve of': ['phrase', '赞成；认可']
};

const $ = (id) => document.getElementById(id);
const sentences = paragraphs.flat();
const prose = $('prose');
const help = $('help');
const detail = $('detail');
const saved = new Set();
let selectedIdx = 0;
let helpIdx = 0;
let detailIdx = 0;
let helpText = '';
let activeIdx = 0;
let playing = false;
let rate = 1;
let fontSize = 23;
let holdPeek = false;
let toastTimer;
let speechGeneration = 0;
let focusReturn = null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

let index = 0;
for (const paragraph of paragraphs) {
  const p = document.createElement('p');
  paragraph.forEach((sentence, i) => {
    if (i) p.append(' ');
    const span = node('span', 'sentence', sentence.en);
    span.dataset.idx = String(index++);
    span.tabIndex = 0;
    span.setAttribute('aria-label', `${sentence.en} 按回车查看句意`);
    p.append(span);
  });
  prose.append(p);
}

function sentenceElement(idx) { return prose.querySelector(`[data-idx="${idx}"]`); }
function markTarget(idx) {
  prose.querySelectorAll('.help-target').forEach(el => el.classList.remove('help-target'));
  if (idx !== null) sentenceElement(idx)?.classList.add('help-target');
}
function closeHelp(restoreFocus = false) {
  help.hidden = true;
  if (detail.hidden) markTarget(null);
  if (restoreFocus) focusReturn?.focus({ preventScroll: true });
}
function positionHelp(rect) {
  const width = help.offsetWidth;
  const height = help.offsetHeight;
  const availableBottom = document.querySelector('.reading-dock').getBoundingClientRect().top;
  const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
  let top = rect.bottom + 10;
  if (top + height > availableBottom - 8) top = rect.top - height - 10;
  help.style.left = `${left}px`;
  help.style.top = `${Math.max(74, Math.min(top, availableBottom - height - 8))}px`;
}
function showHelp(idx, rect, term = '') {
  selectedIdx = idx;
  helpIdx = idx;
  helpText = term || sentences[idx].en;
  focusReturn = sentenceElement(idx);
  const content = $('help-content');
  content.replaceChildren();
  const entry = vocabulary[term.toLowerCase().replace(/[.,!?;:“”]/g, '').trim()];
  $('help-kind').textContent = entry ? '词义' : term ? '结合原句理解' : '句意';
  if (entry) {
    const heading = node('h2', '', term);
    if (entry[2]) heading.append(node('span', 'phonetic', entry[2]));
    const meaning = node('p');
    meaning.append(node('span', 'pos', entry[0]), entry[1]);
    content.append(heading, meaning);
  } else {
    content.append(node('p', 'source', sentences[idx].en), node('p', '', sentences[idx].zh));
  }
  $('help-listen').lastChild.textContent = entry ? '发音' : '听原句';
  $('help-save').querySelector('span').textContent = saved.has(helpText) ? '已收藏' : '收藏';
  $('help-save').setAttribute('aria-pressed', String(saved.has(helpText)));
  help.hidden = false;
  markTarget(idx);
  positionHelp(rect);
}

function caretWord(event, container) {
  let textNode, offset;
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    textNode = caret?.offsetNode; offset = caret?.offset;
  } else if (document.caretRangeFromPoint) {
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
    textNode = caret?.startContainer; offset = caret?.startOffset;
  }
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !container.contains(textNode)) return null;
  const text = textNode.textContent;
  let start = offset, end = offset;
  const isLetter = char => char && /[A-Za-z’'-]/.test(char);
  // 空白处单击只定位阅读位置，不误查紧邻单词。
  if (!isLetter(text[offset]) && !isLetter(text[offset - 1])) return null;
  while (start > 0 && isLetter(text[start - 1])) start--;
  while (end < text.length && isLetter(text[end])) end++;
  const range = document.createRange();
  range.setStart(textNode, start); range.setEnd(textNode, end);
  return { term: text.slice(start, end), rect: range.getBoundingClientRect() };
}

prose.addEventListener('click', event => {
  const span = event.target.closest('[data-idx]');
  if (!span || !window.getSelection()?.isCollapsed) return;
  const idx = Number(span.dataset.idx);
  selectedIdx = idx;
  if (event.altKey) { showHelp(idx, span.getBoundingClientRect()); return; }
  const word = caretWord(event, span);
  if (word?.term) showHelp(idx, word.rect, word.term);
});
prose.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !prose.contains(selection.anchorNode) || !prose.contains(selection.focusNode)) return;
  const text = selection.toString().trim();
  if (!text) return;
  const anchor = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode.parentElement;
  const span = anchor.closest('[data-idx]');
  const end = selection.focusNode.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode.parentElement;
  // 跨句选择保留浏览器的复制行为，不用单句释义冒充整段理解。
  if (!span || end.closest('[data-idx]') !== span) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showHelp(Number(span.dataset.idx), rect, text);
});
prose.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.matches('[data-idx]')) return;
  event.preventDefault();
  showHelp(Number(event.target.dataset.idx), event.target.getBoundingClientRect());
  $('help-close').focus({ preventScroll: true });
});

function openDetail(idx) {
  detailIdx = idx;
  const sentence = sentences[idx];
  $('detail-source').textContent = sentence.en;
  $('detail-meaning').textContent = sentence.zh;
  $('detail-clauses').replaceChildren(...sentence.parts.map(([en, zh]) => {
    const clause = node('div', 'clause');
    clause.tabIndex = 0;
    clause.append(node('b', '', en), node('span', '', zh));
    return clause;
  }));
  $('detail-word').replaceChildren(node('div', 'detail-term', sentence.term[0]), node('p', '', sentence.term[1]));
  closeHelp();
  detail.hidden = false;
  detail.scrollTop = 0;
  document.body.classList.add('detail-open');
  markTarget(idx);
  $('detail-close').focus({ preventScroll: true });
}
function closeDetail() {
  detail.hidden = true;
  document.body.classList.remove('detail-open');
  markTarget(null);
  sentenceElement(detailIdx)?.focus({ preventScroll: true });
}
$('help-close').onclick = () => closeHelp(true);
$('help-detail').onclick = () => openDetail(helpIdx);
$('detail-close').onclick = closeDetail;
$('help-save').onclick = () => {
  if (saved.has(helpText)) saved.delete(helpText); else saved.add(helpText);
  $('help-save').querySelector('span').textContent = saved.has(helpText) ? '已收藏' : '收藏';
  $('help-save').setAttribute('aria-pressed', String(saved.has(helpText)));
};

function announce(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function updatePlayback() {
  $('play').setAttribute('aria-label', playing ? '暂停朗读' : '开始朗读');
  $('play').querySelector('use').setAttribute('href', playing ? '#pause' : '#play');
  prose.querySelectorAll('.current').forEach(el => el.classList.remove('current'));
  if (playing) sentenceElement(activeIdx)?.classList.add('current');
}
function stopAudio() {
  speechGeneration++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  playing = false;
  updatePlayback();
}
function speak(text, continuous = false) {
  stopAudio();
  if (!('speechSynthesis' in window)) { announce('当前浏览器不支持朗读。'); return; }
  const generation = speechGeneration;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-GB'; utterance.rate = rate;
  playing = continuous;
  updatePlayback();
  utterance.onend = () => {
    if (generation !== speechGeneration) return;
    if (continuous && activeIdx < sentences.length - 1) {
      activeIdx++;
      sentenceElement(activeIdx).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      speak(sentences[activeIdx].en, true);
    } else { playing = false; updatePlayback(); }
  };
  utterance.onerror = () => {
    if (generation !== speechGeneration) return;
    playing = false; updatePlayback(); announce('朗读暂不可用，请检查系统语音。');
  };
  speechSynthesis.speak(utterance);
}
$('help-listen').onclick = () => speak(helpText);
$('detail-listen').onclick = () => speak(sentences[detailIdx].en);
$('play').onclick = () => {
  if (playing) stopAudio();
  else { activeIdx = selectedIdx; speak(sentences[activeIdx].en, true); }
};
function jump(delta) {
  const wasPlaying = playing;
  stopAudio();
  activeIdx = Math.max(0, Math.min(sentences.length - 1, activeIdx + delta));
  selectedIdx = activeIdx;
  sentenceElement(activeIdx).scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (wasPlaying) speak(sentences[activeIdx].en, true);
}
$('previous-sentence').onclick = () => jump(-1);
$('next-sentence').onclick = () => jump(1);
$('speed').onclick = () => {
  const rates = [0.8, 1, 1.2];
  rate = rates[(rates.indexOf(rate) + 1) % rates.length];
  $('speed').textContent = `${rate.toFixed(1)}×`;
  if (playing) speak(sentences[activeIdx].en, true);
};

function closeMenus() {
  for (const name of ['contents', 'appearance']) {
    $(name).hidden = true;
    $(`${name}-toggle`).setAttribute('aria-expanded', 'false');
  }
}
for (const name of ['contents', 'appearance']) {
  $(`${name}-toggle`).onclick = () => {
    const opening = $(name).hidden;
    closeMenus(); closeHelp();
    $(name).hidden = !opening;
    $(`${name}-toggle`).setAttribute('aria-expanded', String(opening));
  };
}
$('chapter-start').onclick = () => { $('reading-scroll').scrollTo({ top: 0, behavior: 'smooth' }); closeMenus(); };
function changeFont(delta) {
  fontSize = Math.max(18, Math.min(29, fontSize + delta));
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  $('font-value').textContent = String(fontSize);
  $('font-smaller').disabled = fontSize === 18;
  $('font-larger').disabled = fontSize === 29;
}
$('font-smaller').onclick = () => changeFont(-1);
$('font-larger').onclick = () => changeFont(1);
document.querySelectorAll('[data-theme]').forEach(button => {
  button.onclick = () => {
    document.body.dataset.theme = button.dataset.theme;
    document.querySelectorAll('[data-theme]').forEach(item => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
  };
});
$('finish').onclick = () => {
  $('finish').disabled = true;
  $('finish').textContent = '已读完';
  $('finish-status').textContent = '阅读到此，停一停也很好。';
};
$('library').onclick = () => announce('这是阅读交互原型，尚未连接书架。');

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#help, #prose')) closeHelp();
  if (!event.target.closest('.menu, #contents-toggle, #appearance-toggle')) closeMenus();
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, [contenteditable=true]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (!help.hidden) closeHelp(true);
    else if (!$('contents').hidden || !$('appearance').hidden) {
      const id = !$('appearance').hidden ? 'appearance-toggle' : 'contents-toggle';
      closeMenus(); $(id).focus();
    } else if (!detail.hidden) closeDetail();
  }
  // 临时句意锁定按下时的目标；与朗读推进、已收藏状态分别管理。
  if (event.key.toLowerCase() === 'h' && !event.repeat && help.hidden && detail.hidden) {
    holdPeek = true;
    const idx = playing ? activeIdx : selectedIdx;
    showHelp(idx, sentenceElement(idx).getBoundingClientRect());
  }
});
function releasePeek() { if (holdPeek) { closeHelp(); holdPeek = false; } }
document.addEventListener('keyup', event => { if (event.key.toLowerCase() === 'h') releasePeek(); });
window.addEventListener('blur', releasePeek);
document.addEventListener('visibilitychange', () => { if (document.hidden) { releasePeek(); stopAudio(); } });
window.addEventListener('pagehide', stopAudio);
window.addEventListener('resize', closeHelp);
$('reading-scroll').addEventListener('scroll', () => {
  closeHelp();
  const scroller = $('reading-scroll');
  const range = scroller.scrollHeight - scroller.clientHeight;
  const percent = range > 0 ? Math.round(scroller.scrollTop / range * 100) : 100;
  $('progress-fill').style.width = `${percent}%`;
  $('progress-label').textContent = `${percent}%`;
  // 视口断点只供下一次帮助/朗读使用，不替换已打开的解析对象。
  if (!playing) {
    const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    for (let i = 0; i < sentences.length; i++) {
      if (sentenceElement(i).getBoundingClientRect().top < top) selectedIdx = i;
    }
  }
}, { passive: true });
