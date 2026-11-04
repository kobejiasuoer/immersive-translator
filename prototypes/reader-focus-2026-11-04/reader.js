/* Standalone interaction prototype. No application settings, data, or network calls. */
"use strict";

const sentences = [
  { id:0, paragraph:0, en:"High above the city, on a tall column, stood the statue of the Happy Prince.", zh:"在城市的高处，一根高高的柱子上，矗立着快乐王子的雕像。", structure:"<strong>stood the statue</strong> 是倒装：先交代地点，再让雕像进入视野。正常语序是 The statue stood high above the city。" },
  { id:1, paragraph:0, en:"He was gilded all over with thin leaves of fine gold, for eyes he had two bright sapphires, and a large red ruby glowed on his sword-hilt.", zh:"他全身贴满薄薄的纯金箔，眼睛是两颗明亮的蓝宝石，剑柄上还闪耀着一颗硕大的红宝石。", structure:"三个并列画面：<strong>was gilded</strong> 写全身，<strong>had two bright sapphires</strong> 写眼睛，<strong>a ruby glowed</strong> 写剑柄。leaves 在这里是金箔，而非树叶。" },
  { id:2, paragraph:1, en:"He was very much admired indeed.", zh:"他的确深受人们的赞赏。", structure:"<strong>was admired</strong> 是被动语态；very much 加深程度，indeed 再次强调「的确」。" },
  { id:3, paragraph:1, en:"“He is as beautiful as a weathercock,” remarked one of the Town Councillors who wished to gain a reputation for having artistic tastes; “only not quite so useful,” he added, fearing lest people should think him unpractical, which he really was not.", zh:"“他像风向标一样美。”一位想以艺术品位博得名声的市议员评论道；“只是不那么实用。”他又补充了一句，唯恐人们觉得他不切实际，而他自认为并非如此。", structure:"先抓主干：<strong>one of the Town Councillors remarked … he added …</strong>。who wished… 修饰议员；fearing lest… 解释他为何要补上后半句。这句话也在讽刺他的虚荣。" },
  { id:4, paragraph:2, en:"“Why can’t you be like the Happy Prince?” asked a sensible mother of her little boy who was crying for the moon.", zh:"“你为什么不能像快乐王子一样呢？”一位明事理的母亲问她的小男孩；他正哭闹着要月亮。", structure:"<strong>asked a sensible mother</strong> 是引语后的倒装。crying for the moon 既是孩子在要月亮，也暗含「想要不可能得到的东西」。" },
  { id:5, paragraph:2, en:"“The Happy Prince never dreams of crying for anything.”", zh:"“快乐王子做梦也不会为了什么东西哭闹。”", structure:"<strong>dream of doing</strong> 表示想到或梦想做某事。never dreams of 强调「连想都不会想」。" },
  { id:6, paragraph:3, en:"“I am glad there is some one in the world who is quite happy,” muttered a disappointed man as he gazed at the wonderful statue.", zh:"“我很高兴，世上还有一个完全快乐的人。”一个失意的人凝望着那座美妙的雕像，低声说道。", structure:"主干是 <strong>a disappointed man muttered</strong>。as he gazed… 交代说话时的动作；who is quite happy 修饰 some one。" },
  { id:7, paragraph:4, en:"“He looks just like an angel,” said the Charity Children as they came out of the cathedral in their bright scarlet cloaks, and their clean white pinafores.", zh:"“他看上去就像一位天使。”慈善学校的孩子们说。他们穿着鲜红的斗篷和干净的白围裙，从大教堂里走出来。", structure:"主干是 <strong>the Charity Children said</strong>。as 引出他们说话时的情景；in… 描写孩子们的衣着。" },
  { id:8, paragraph:4, en:"“How do you know?” said the Mathematical Master, “you have never seen one.”", zh:"“你们怎么知道？”数学老师问，“你们从来没见过天使。”", structure:"<strong>one</strong> 代替前句的 angel，避免重复。have never seen 是现在完成时，表示到现在为止的经历。" },
];

const glossary = {
  gilded:{ ipa:"/ˈɡɪldɪd/", pos:"adj.", zh:"镀金的；贴了金箔的" },
  column:{ ipa:"/ˈkɒləm/", pos:"n.", zh:"柱；圆柱" },
  statue:{ ipa:"/ˈstætʃuː/", pos:"n.", zh:"雕像；塑像" },
  leaves:{ ipa:"/liːvz/", pos:"n.", zh:"（金属的）薄片；这里指金箔" },
  "thin leaves of fine gold":{ pos:"短语", zh:"薄薄的纯金箔；leaf 在这里指极薄的金属片" },
  fine:{ ipa:"/faɪn/", pos:"adj.", zh:"（金属）纯的；精制的" },
  sapphires:{ ipa:"/ˈsæfaɪəz/", pos:"n.", zh:"蓝宝石（复数）" },
  ruby:{ ipa:"/ˈruːbi/", pos:"n.", zh:"红宝石" },
  "sword-hilt":{ pos:"n.", zh:"剑柄" },
  glowed:{ ipa:"/ɡləʊd/", pos:"v.", zh:"发出柔和的光；闪耀" },
  admired:{ ipa:"/ədˈmaɪəd/", pos:"v.", zh:"受到赞赏；被钦佩" },
  weathercock:{ ipa:"/ˈweðəkɒk/", pos:"n.", zh:"风向标（常做成公鸡形状）" },
  artistic:{ ipa:"/ɑːˈtɪstɪk/", pos:"adj.", zh:"艺术的；有艺术品位的" },
  reputation:{ ipa:"/ˌrepjʊˈteɪʃən/", pos:"n.", zh:"名声；声誉" },
  "gain a reputation":{ pos:"短语", zh:"获得名声；博得声誉" },
  "crying for the moon":{ pos:"习语", zh:"想要不可能得到的东西；这里也指孩子哭着要月亮" },
  muttered:{ ipa:"/ˈmʌtəd/", pos:"v.", zh:"小声嘀咕；低声说" },
  gazed:{ ipa:"/ɡeɪzd/", pos:"v.", zh:"凝视；注视" },
  cathedral:{ ipa:"/kəˈθiːdrəl/", pos:"n.", zh:"大教堂" },
  scarlet:{ ipa:"/ˈskɑːlət/", pos:"adj.", zh:"鲜红色的" },
  pinafores:{ ipa:"/ˈpɪnəfɔːz/", pos:"n.", zh:"围裙；围裙式连衣裙（复数）" },
};

const paths = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon:'<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 1 1 3.8 1.9c-1 .6-1.5 1-1.5 2.1m0 3h.01"/>',
  play:'<path d="m9 5 10 7-10 7Z"/>', pause:'<path d="M9 5v14M15 5v14"/>',
  previous:'<path d="M5 5v14m14-14-10 7 10 7Z"/>', next:'<path d="M19 5v14M5 5l10 7-10 7Z"/>',
  volume:'<path d="m11 5-6 4H2v6h3l6 4Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  bookmark:'<path d="M6 3h12v18l-6-4-6 4Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  cursor:'<path d="m5 3 15 9-8 1-3 8Z"/>', copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
};
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.help}</svg>`;
document.querySelectorAll('[data-icon]').forEach(node => node.innerHTML = icon(node.dataset.icon));

const state = { helper:null, peek:null, target:0, playId:0, playing:false, generation:0, menu:null, font:22, bilingual:false, phrases:false, selection:null, savedWords:new Set(), savedSentences:new Set(), structure:false, rate:1, toastTimer:null };
const groups = [...new Set(sentences.map(s => s.paragraph))].map(paragraph => sentences.filter(s => s.paragraph === paragraph));

function english(s) {
  const parts = s.en.split(/(thin leaves of fine gold|gain a reputation|crying for the moon)/);
  const tokenize = text => text.split(/([A-Za-z]+(?:[’'-][A-Za-z]+)*)/g).map((part, i) => i % 2 ? `<span class="word" data-word="${esc(part.toLowerCase())}">${esc(part)}</span>` : esc(part)).join('');
  return `<span class="sentence" data-sid="${s.id}">${parts.map((part,i) => state.phrases && i % 2 ? `<span class="phrase">${tokenize(part)}</span>` : tokenize(part)).join('')}</span>`;
}

function announce(text) { $('#status').textContent = text; }
function notify(text) {
  clearTimeout(state.toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  state.toastTimer = setTimeout(() => $('#toast').hidden = true, 2600);
}

function helperMarkup(help, temporary) {
  const sentence = sentences[help.sid];
  const close = temporary ? '<span>松开 H 返回</span>' : `<button class="icon-button" data-close-help aria-label="收起帮助，继续阅读">${icon('close')}</button>`;
  if (help.kind === 'word') {
    const entry = glossary[help.text.toLowerCase()];
    const saved = state.savedWords.has(help.text.toLowerCase());
    return `<section class="helper" aria-label="${esc(help.text)} 的释义"><div class="helper-header"><span>在这句话里</span>${close}</div><div class="word-heading"><h2 lang="en">${esc(help.text)}</h2>${entry?.ipa ? `<span class="pronunciation">${entry.ipa}</span>` : ''}</div><p class="definition">${entry ? `<span class="word-type">${entry.pos}</span>${entry.zh}` : '暂无简明释义，可以结合整句理解。'}</p><div class="helper-actions"><button data-listen-word>${icon('volume')}听发音</button><button data-save-word aria-pressed="${saved}">${icon(saved ? 'check' : 'bookmark')}${saved ? '已记下' : '记下这个表达'}</button><button class="meaning-action" data-explain-sentence>读懂整句</button></div></section>`;
  }
  const paragraph = help.kind === 'paragraph';
  const saved = state.savedSentences.has(help.sid);
  const meaning = paragraph ? groups[sentence.paragraph].map(s => s.zh).join('') : sentence.zh;
  return `<section class="helper" aria-label="${paragraph ? '段落' : '句子'}释义"><div class="helper-header"><span>${temporary ? '临时看句意' : paragraph ? '这一段的意思' : '这句话的意思'}</span>${close}</div>${paragraph ? '' : `<blockquote lang="en">${esc(sentence.en)}</blockquote>`}<p>${esc(meaning)}</p>${temporary ? '' : `<div class="helper-actions"><button data-listen-help>${icon('volume')}听${paragraph ? '这一段' : '这一句'}</button>${paragraph ? '' : `<button data-structure aria-expanded="${state.structure}">看句子结构</button><button data-save-sentence aria-pressed="${saved}">${icon(saved ? 'check' : 'bookmark')}${saved ? '已收藏' : '收藏句子'}</button>`}</div>${!paragraph && state.structure ? `<p class="structure">${sentence.structure}</p>` : ''}`}</section>`;
}

function renderHelp() {
  const focused = document.activeElement;
  const focusedParagraph = focused?.closest('[data-paragraph]')?.dataset.paragraph;
  const focusedAction = focused?.tagName === 'BUTTON' ? [...focused.attributes].find(a => a.name.startsWith('data-')) : null;
  // Keep paragraph DOM and text selections stable when opening or dismissing help.
  document.querySelectorAll('.helper').forEach(node => node.remove());
  const help = state.peek ?? state.helper;
  if (help && !state.bilingual) {
    const paragraph = sentences[help.sid].paragraph;
    $(`[data-paragraph="${paragraph}"]`).insertAdjacentHTML('beforeend', helperMarkup(help, Boolean(state.peek)));
  }
  document.querySelectorAll('.sentence').forEach(node => node.classList.toggle('is-helped', Boolean(help && !state.bilingual && help.kind !== 'paragraph' && help.sid === Number(node.dataset.sid))));
  document.querySelectorAll('.paragraph-help').forEach(node => node.setAttribute('aria-expanded', String(Boolean(help && !state.bilingual && sentences[help.sid].paragraph === Number(node.dataset.help)))));
  if (focusedAction && !focused.isConnected && focusedParagraph !== undefined) {
    const replacement = $(`[data-paragraph="${focusedParagraph}"] [${focusedAction.name}]`);
    replacement?.focus({preventScroll:true});
  }
}

function renderStory() {
  $('#story').innerHTML = groups.map((group,i) => `<section class="paragraph" data-paragraph="${i}"><button class="paragraph-help" data-help="${i}" aria-label="解释以 ${esc(group[0].en.slice(0,38))} 开头的段落" aria-expanded="false">${icon('help')}</button><p class="prose" lang="en">${group.map(english).join(' ')}</p>${state.bilingual ? `<p class="parallel-meaning">${group.map(s => esc(s.zh)).join('')}</p>` : ''}</section>`).join('');
  renderHelp();
  renderPlayback();
}

function openHelp(help) {
  state.helper = help;
  state.peek = null;
  state.target = help.sid;
  state.structure = false;
  hideSelection();
  closeMenu();
  renderHelp();
  announce(help.kind === 'word' ? `已显示 ${help.text} 的释义` : '已显示句意');
}

function closeHelp(returnFocus = false) {
  const paragraph = state.helper ? sentences[state.helper.sid].paragraph : null;
  state.helper = null;
  state.peek = null;
  renderHelp();
  if (returnFocus && paragraph !== null) $(`[data-help="${paragraph}"]`)?.focus({preventScroll:true});
}

function closeMenu(returnFocus = false) {
  const menu = state.menu;
  state.menu = null;
  for (const name of ['appearance','assist']) {
    $(`#${name}`).hidden = true;
    $(`#${name}-toggle`).setAttribute('aria-expanded','false');
  }
  if (returnFocus && menu) $(`#${menu}-toggle`).focus();
}

function renderPlayback() {
  document.querySelectorAll('.sentence').forEach(node => node.classList.toggle('is-playing', state.playing && Number(node.dataset.sid) === state.playId));
  $('#play').innerHTML = icon(state.playing ? 'pause' : 'play');
  $('#play').setAttribute('aria-label',state.playing ? '暂停朗读' : '朗读原文');
  $('#play-status').textContent = state.playing ? `正在听 · ${state.playId + 1} / ${sentences.length}` : state.playId ? `继续听 · ${state.playId + 1} / ${sentences.length}` : '听原文';
  $('#track-fill').style.width = `${state.playId / sentences.length * 100}%`;
  $('#previous').disabled = state.playId === 0;
  $('#next').disabled = state.playId === sentences.length - 1;
}

function stopSpeech() {
  state.generation += 1;
  state.playing = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  renderPlayback();
}

function speak(text, onend) {
  if (!('speechSynthesis' in window)) { notify('此浏览器不支持朗读，仍可继续阅读。'); stopSpeech(); return; }
  const utterance = new SpeechSynthesisUtterance(text);
  const generation = state.generation;
  utterance.lang = 'en-GB';
  utterance.rate = state.rate;
  utterance.onend = () => { if (generation === state.generation) onend?.(); };
  utterance.onerror = event => { if (generation !== state.generation) return; stopSpeech(); if (!['interrupted','canceled'].includes(event.error)) notify('暂时无法朗读，请检查浏览器语音是否可用。'); };
  speechSynthesis.speak(utterance);
}

function playSentence() {
  state.playing = true;
  renderPlayback();
  speak(sentences[state.playId].en, () => {
    if (!state.playing) return;
    if (state.playId === sentences.length - 1) { stopSpeech(); announce('节选朗读结束'); return; }
    state.playId += 1;
    playSentence();
  });
}

function listen(text) { stopSpeech(); speak(text); }
function hideSelection() { $('#selection-tools').hidden = true; state.selection = null; }

$('#story').addEventListener('pointerover', event => {
  const sentence = event.target.closest('[data-sid]');
  if (sentence) state.target = Number(sentence.dataset.sid);
});
$('#story').addEventListener('focusin', event => {
  const button = event.target.closest('[data-help]');
  if (button) state.target = groups[Number(button.dataset.help)][0].id;
});
$('#story').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) {
    if (button.hasAttribute('data-help')) {
      const group = groups[Number(button.dataset.help)];
      if (state.helper?.kind === 'paragraph' && state.helper.sid === group[0].id) closeHelp();
      else openHelp({kind:'paragraph',sid:group[0].id});
    } else if (button.hasAttribute('data-close-help')) closeHelp(true);
    else if (button.hasAttribute('data-explain-sentence')) openHelp({kind:'sentence',sid:state.helper.sid});
    else if (button.hasAttribute('data-listen-word')) listen(state.helper.text);
    else if (button.hasAttribute('data-listen-help')) listen(state.helper.kind === 'paragraph' ? groups[sentences[state.helper.sid].paragraph].map(s => s.en).join(' ') : sentences[state.helper.sid].en);
    else if (button.hasAttribute('data-save-word')) {
      const word = state.helper.text.toLowerCase();
      if (state.savedWords.has(word)) state.savedWords.delete(word); else state.savedWords.add(word);
      renderHelp();
      announce(state.savedWords.has(word) ? '已在本次预览中记下这个表达' : '已取消记下');
    } else if (button.hasAttribute('data-save-sentence')) {
      const id = state.helper.sid;
      if (state.savedSentences.has(id)) state.savedSentences.delete(id); else state.savedSentences.add(id);
      renderHelp();
      announce(state.savedSentences.has(id) ? '已在本次预览中收藏句子' : '已取消收藏');
    } else if (button.hasAttribute('data-structure')) { state.structure = !state.structure; renderHelp(); }
    return;
  }
  if (!getSelection()?.isCollapsed || event.detail > 1 || state.bilingual) return;
  const word = event.target.closest('[data-word]');
  const sentence = event.target.closest('[data-sid]');
  if (word && sentence) openHelp({kind:'word',sid:Number(sentence.dataset.sid),text:word.dataset.word});
});

document.addEventListener('pointerup', event => {
  if (event.target.closest('.helper,.selection-tools,.popover,input,button')) return;
  const selection = getSelection();
  if (!selection || selection.isCollapsed) { hideSelection(); return; }
  const start = selection.anchorNode?.parentElement?.closest('[data-sid]');
  const end = selection.focusNode?.parentElement?.closest('[data-sid]');
  if (!start || !end) { hideSelection(); return; }
  const text = selection.toString().trim();
  if (!text || text.length > 600) { hideSelection(); return; }
  const sid = Number(start.dataset.sid);
  const kind = text.split(/\s+/).length > 7 || start !== end ? 'sentence' : 'word';
  state.selection = {sid,text,kind};
  state.target = sid;
  const range = selection.getRangeAt(0).getBoundingClientRect();
  const tools = $('#selection-tools');
  $('#selection-label').textContent = kind === 'sentence' ? '看句意' : '查释义';
  tools.hidden = false;
  tools.style.left = `${Math.max(8,Math.min(innerWidth-tools.offsetWidth-8,range.left + range.width / 2 - tools.offsetWidth / 2))}px`;
  tools.style.top = `${Math.min(innerHeight-tools.offsetHeight-8, Math.max(8,range.top-tools.offsetHeight-8))}px`;
});
// Keep the browser selection while clicking the contextual toolbar.
$('#selection-tools').addEventListener('pointerdown', event => event.preventDefault());
$('#explain-selection').addEventListener('click', () => {
  if (!state.selection) return;
  const {sid,text,kind} = state.selection;
  if (kind === 'sentence') openHelp({kind:'sentence',sid});
  else openHelp({kind:'word',sid,text});
});
$('#listen-selection').addEventListener('click', () => { if (state.selection) listen(state.selection.text); });
$('#copy-selection').addEventListener('click', async () => {
  if (!state.selection) return;
  try { await navigator.clipboard.writeText(state.selection.text); notify('已复制'); }
  catch { notify('请按 Ctrl+C 复制选中的文字'); }
});

for (const name of ['appearance','assist']) {
  $(`#${name}-toggle`).addEventListener('click', () => {
    const opening = state.menu !== name;
    closeMenu();
    if (opening) { state.menu = name; $(`#${name}`).hidden = false; $(`#${name}-toggle`).setAttribute('aria-expanded','true'); }
  });
}
document.querySelectorAll('[data-close-menu]').forEach(button => button.addEventListener('click', () => closeMenu(true)));
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.tool-wrap')) closeMenu();
  if (!event.target.closest('.selection-tools,.prose')) hideSelection();
});
document.querySelectorAll('[data-font]').forEach(button => button.addEventListener('click', () => {
  state.font = Math.max(18,Math.min(28,state.font + Number(button.dataset.font)));
  document.documentElement.style.setProperty('--font-size',`${state.font}px`);
  $('#font-value').value = String(state.font);
  document.querySelector('[data-font="-1"]').disabled = state.font === 18;
  document.querySelector('[data-font="1"]').disabled = state.font === 28;
}));
$('#phrases').addEventListener('change', event => { state.phrases = event.target.checked; renderStory(); });
$('#bilingual').addEventListener('change', event => {
  state.bilingual = event.target.checked;
  state.peek = null;
  hideSelection();
  renderStory();
  announce(state.bilingual ? '双语对照已开启' : '已回到原文');
});
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').innerHTML = icon(dark ? 'moon' : 'sun');
  $('#theme').setAttribute('aria-label',dark ? '切换浅色外观' : '切换深色外观');
  $('#theme').title = dark ? '切换浅色外观' : '切换深色外观';
});
$('#dismiss-hint').addEventListener('click', () => { $('#first-hint').hidden = true; });
$('#back-top').addEventListener('click', () => { $('#title').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); });
$('#play').addEventListener('click', () => { if (state.playing) stopSpeech(); else { stopSpeech(); playSentence(); } });
for (const [id,delta] of [['previous',-1],['next',1]]) $( `#${id}`).addEventListener('click', () => {
  const playing = state.playing;
  stopSpeech();
  state.playId = Math.max(0,Math.min(sentences.length-1,state.playId + delta));
  if (playing) playSentence(); else renderPlayback();
});
$('#speed').addEventListener('click', () => {
  const rates = [1, .8, 1.2];
  state.rate = rates[(rates.indexOf(state.rate)+1) % rates.length];
  $('#speed').textContent = `${state.rate.toFixed(1)}×`;
  $('#speed').setAttribute('aria-label',`朗读速度 ${state.rate.toFixed(1)} 倍`);
  if (state.playing) { stopSpeech(); playSentence(); }
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,[contenteditable="true"]') || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === 'Escape') {
    if (state.menu) closeMenu(true);
    else if (!$('#selection-tools').hidden) hideSelection();
    else closeHelp(true);
    event.preventDefault();
  }
  if (event.key.toLowerCase() === 'h' && !event.repeat && !state.bilingual && !state.menu) {
    event.preventDefault();
    state.peek = {kind:'sentence',sid:state.target};
    renderHelp();
  }
});
function releasePeek() { if (state.peek) { state.peek = null; renderHelp(); } }
document.addEventListener('keyup', event => { if (event.key.toLowerCase() === 'h') releasePeek(); });
window.addEventListener('blur',releasePeek);
document.addEventListener('visibilitychange', () => { if (document.hidden) { releasePeek(); stopSpeech(); } });
window.addEventListener('pagehide',stopSpeech);
window.addEventListener('scroll', hideSelection, {passive:true});
renderStory();
