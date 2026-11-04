// Independent interaction prototype. Explanations below are curated fixtures, not AI responses.
const paragraphs = [
  [
    { text: "High above the city, on a tall column, stood the statue of the Happy Prince.", meaning: "The Happy Prince's statue stood on a tall column, high above the city.", parts: [["High above the city, on a tall column", "First, picture the place: a tall column above the city."], ["stood the statue of the Happy Prince", "The subject comes after the verb. In ordinary word order: the statue stood there."]], phrase: ["Place first, subject second", "Putting the place first lets the reader discover the statue, almost as if looking up at it."] },
    { text: "He was gilded all over with thin leaves of fine gold, for eyes he had two bright sapphires, and a large red ruby glowed on his sword-hilt.", meaning: "The statue was covered in thin sheets of pure gold. Its eyes were blue jewels, and a red jewel shone on the handle of its sword.", parts: [["He was gilded all over with thin leaves of fine gold", "A thin layer of pure gold covered the whole statue. Here, leaves means very thin sheets."], ["for eyes he had two bright sapphires", "The two blue jewels served as his eyes."], ["a large red ruby glowed on his sword-hilt", "A red jewel shone on the handle of his sword."]], phrase: ["be gilded with", "To have a thin layer of gold on the surface. Something gilded is not necessarily made of solid gold."] }
  ],
  [
    { text: "He was very much admired indeed.", meaning: "People really admired the statue.", parts: [["He was very much admired", "The statue received people's admiration. Was admired is passive."], ["indeed", "This strengthens the statement: people really did admire him."]], phrase: ["very much admired", "Widely liked and respected; admired by many people."] },
    { text: "“He is as beautiful as a weathercock,” remarked one of the Town Councillors who wished to gain a reputation for having artistic tastes; “only not quite so useful,” he added, fearing lest people should think him impractical, which he really was not.", meaning: "A councillor wanted to seem knowledgeable about art, so he praised the statue. Then he added that it was not very useful, because he also wanted to seem practical.", parts: [["“He is as beautiful as a weathercock,” remarked one of the Town Councillors", "A local official compares the statue's beauty to a decorative figure that shows the wind's direction."], ["who wished to gain a reputation for having artistic tastes", "The official wants other people to believe he understands and appreciates art."], ["“only not quite so useful,” he added", "He adds a criticism: the statue is beautiful, but it has less practical use."], ["fearing lest people should think him impractical, which he really was not", "He worries about appearing impractical. The narrator's final comment adds a gently ironic tone."]], phrase: ["gain a reputation for", "Become known for a particular quality or habit. Here, he wants to become known for his good taste in art."] }
  ],
  [
    { text: "“Why can’t you be like the Happy Prince?” asked a sensible mother of her little boy who was crying for the moon.", meaning: "A mother tells her unhappy son to be more like the statue. He is upset because he wants something he cannot have.", parts: [["“Why can’t you be like the Happy Prince?”", "The mother is telling the boy to follow the Prince's example."], ["asked a sensible mother of her little boy", "The mother asks this question of her son."], ["who was crying for the moon", "This describes the boy. He wants something impossible to obtain."]], phrase: ["cry for the moon", "Want something impossible to get. The phrase also fits the picture of a child crying."] },
    { text: "“The Happy Prince never dreams of crying for anything.”", meaning: "The mother says the Happy Prince would never even think of crying because he wanted something.", parts: [["The Happy Prince never dreams of", "Never dreams of means would never even consider."], ["crying for anything", "Crying because he wants something."]], phrase: ["dream of doing something", "Imagine or consider doing something. With never, it means the thought would not even occur to someone."] }
  ],
  [
    { text: "“I am glad there is someone in the world who is quite happy,” muttered a disappointed man as he gazed at the wonderful statue.", meaning: "An unhappy man looks at the statue and quietly says he is glad that at least someone is happy.", parts: [["“I am glad there is someone in the world who is quite happy,”", "These are the man's words. The happy person he refers to is the statue."], ["muttered a disappointed man", "The unhappy man speaks quietly, perhaps mostly to himself."], ["as he gazed at the wonderful statue", "He says this while looking steadily at the statue."]], phrase: ["gaze at", "Look steadily at something for a while, often with interest or admiration."] }
  ]
];
const entries = {
  gilded: ["/ˈɡɪldɪd/", "covered with a thin layer of gold"],
  column: ["/ˈkɑːləm/", "a tall, solid structure that supports or displays something"],
  statue: ["/ˈstætʃuː/", "a figure of a person or animal made from stone, metal, or another material"],
  leaves: ["/liːvz/", "very thin sheets; here, thin sheets of gold"],
  fine: ["/faɪn/", "pure and of high quality; here, describing the gold"],
  sapphires: ["/ˈsæfaɪərz/", "precious stones that are usually bright blue"],
  ruby: ["/ˈruːbi/", "a precious stone with a deep red colour"],
  glowed: ["/ɡloʊd/", "gave off a soft, steady light"],
  "sword-hilt": ["/ˈsɔːrd hɪlt/", "the handle of a sword"],
  admired: ["/ədˈmaɪərd/", "looked at with pleasure, respect, or approval"],
  indeed: ["/ɪnˈdiːd/", "really; used here to make the statement stronger"],
  weathercock: ["/ˈweðərkɑːk/", "a metal figure, often shaped like a rooster, that turns to show the wind's direction"],
  remarked: ["/rɪˈmɑːrkt/", "said something as a comment"],
  councillors: ["/ˈkaʊnsələrz/", "people elected to help govern a town or local area"],
  reputation: ["/ˌrepjəˈteɪʃn/", "what other people generally think or say about someone"],
  artistic: ["/ɑːrˈtɪstɪk/", "connected with art or an understanding of beauty"],
  tastes: ["/teɪsts/", "preferences and judgement; here, an appreciation of art"],
  useful: ["/ˈjuːsfəl/", "able to serve a practical purpose"],
  fearing: ["/ˈfɪərɪŋ/", "feeling worried that something unpleasant might happen"],
  lest: ["/lest/", "because of the risk that something might happen"],
  impractical: ["/ɪmˈpræktɪkəl/", "not sensible or useful in real situations"],
  sensible: ["/ˈsensəbəl/", "showing good judgement and practical understanding"],
  muttered: ["/ˈmʌtərd/", "said something in a low voice, often because of unhappiness"],
  disappointed: ["/ˌdɪsəˈpɔɪntɪd/", "unhappy because something was not as good as hoped"],
  gazed: ["/ɡeɪzd/", "looked steadily for a while"],
  wonderful: ["/ˈwʌndərfəl/", "very beautiful or impressive"],
  "gain a reputation": ["", "become known by other people for a particular quality or habit"],
  "gain a reputation for": ["", "become known for a particular quality or habit"],
  "artistic tastes": ["", "an understanding and appreciation of art and beauty"],
  "crying for the moon": ["", "wanting something impossible to get"],
  "gazed at": ["", "looked steadily at something for a while"],
  "never dreams of": ["", "would never even think of doing something"]
};
const $ = (selector) => document.querySelector(selector);
const sentences = paragraphs.flat();
const prose = $("#prose");
const card = $("#help-card");
const narrow = matchMedia("(max-width: 760px)");
let helpTarget = null;
let pointerDown = false;
let selectionTimer;
let selectionSignature = "";
let dismissedSelectionSignature = "";
let selectionTarget = null;
let focusReturnTarget = null;
let resumeReadingAfterHelp = false;
let toastTimer;
let size = 23;
let saved = [];
const storageKey = "reader-first-prototype-2026-11-04";
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(stored)) saved = stored.filter(item => item && typeof item.text === "string" && typeof item.meaning === "string");
} catch { /* The prototype remains usable when local storage is unavailable. */ }

let idx = 0;
for (const paragraph of paragraphs) {
  const p = document.createElement("p");
  for (const sentence of paragraph) {
    if (p.childNodes.length) p.append(" ");
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.idx = String(idx++);
    span.textContent = sentence.text;
    p.append(span);
  }
  prose.append(p);
}
const sentenceElement = (index) => prose.querySelector(`[data-idx="${index}"]`);
const sentenceOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(".sentence");
const normalized = (text) => text.trim().toLowerCase().replace(/^[“”‘’.,!?;:\s]+|[“”‘’.,!?;:\s]+$/g, "").replace(/\s+/g, " ");
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 2200);
}
function hideSelectionAction() {
  $("#selection-action").hidden = true;
  selectionTarget = null;
}
function closeHelp(restoreFocus = false) {
  if (!card.open) return;
  if (restoreFocus) focusReturnTarget = prose;
  card.close();
}
function positionSelectionAction(rect) {
  const action = $("#selection-action");
  action.hidden = false;
  const box = action.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - box.width / 2, innerWidth - box.width - 12));
  const bottomLimit = innerHeight - 88;
  let top = rect.bottom + 8;
  if (top + box.height > bottomLimit) top = rect.top - box.height - 8;
  action.style.left = `${left}px`;
  action.style.top = `${Math.max(10, Math.min(top, bottomLimit - box.height))}px`;
}
function copyRect(rect) {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}
function positionHelpCard() {
  if (!card.open || !helpTarget) return;
  card.style.removeProperty("left");
  card.style.removeProperty("top");
  card.style.removeProperty("max-height");
  if (narrow.matches) return;

  const margin = 16;
  const gap = 12;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = innerHeight;
  const rect = helpTarget.rect;
  const column = $(".reading-column").getBoundingClientRect();
  const width = card.getBoundingClientRect().width;
  const clampLeft = value => Math.max(margin, Math.min(value, viewportWidth - width - margin));
  let left;
  let top;
  card.style.maxHeight = `${viewportHeight - margin * 2}px`;

  if (viewportWidth - column.right - gap - margin >= width || column.left - gap - margin >= width) {
    // Use the page margin when it can hold the whole card without covering prose.
    left = viewportWidth - column.right - gap - margin >= width ? column.right + gap : column.left - gap - width;
    const height = card.getBoundingClientRect().height;
    top = Math.max(margin, Math.min(rect.top, viewportHeight - height - margin));
  } else {
    const belowTop = Math.max(margin, Math.min(rect.bottom + gap, viewportHeight - margin));
    const aboveBottom = Math.min(viewportHeight - margin, Math.max(margin, rect.top - gap));
    const belowSpace = viewportHeight - margin - belowTop;
    const aboveSpace = aboveBottom - margin;
    const height = card.getBoundingClientRect().height;
    left = clampLeft(rect.left + rect.width / 2 - width / 2);
    if (Math.max(belowSpace, aboveSpace) < Math.min(200, viewportHeight - margin * 2)) {
      // A long selection can occupy the viewport; keep the card usable even if it must overlap it.
      top = Math.max(margin, Math.min(rect.top, viewportHeight - height - margin));
    } else {
      const placeBelow = belowSpace >= height || (aboveSpace < height && belowSpace >= aboveSpace);
      card.style.maxHeight = `${placeBelow ? belowSpace : aboveSpace}px`;
      top = placeBelow ? belowTop : aboveBottom - card.getBoundingClientRect().height;
    }
  }
  card.style.left = `${clampLeft(left)}px`;
  card.style.top = `${Math.max(margin, top)}px`;
}
function updateSaveButton() {
  const exists = helpTarget && saved.some(item => item.text === helpTarget.text);
  $("#save-word").disabled = !helpTarget?.hasMeaning;
  $("#save-word").title = helpTarget?.hasMeaning ? "" : "当前示例没有这段选文的释义，暂不能收藏";
  $("#save-word").textContent = exists ? "已收藏" : "收藏";
  $("#save-word").setAttribute("aria-pressed", String(Boolean(exists)));
  $("#saved-count").textContent = saved.length ? String(saved.length) : "";
}
function describeSelection(target) {
  const { text, startIdx, endIdx } = target;
  const key = normalized(text);
  const entry = entries[key];
  const isWord = /^[a-z'-]+$/i.test(key);
  const sentence = sentences[startIdx];
  const isWholeSentence = startIdx === endIdx && key === normalized(sentence.text);
  const isCrossSentence = startIdx !== endIdx;
  const kind = isWholeSentence ? "sentence" : isWord ? "word" : "phrase";
  const hasMeaning = Boolean(entry || isWholeSentence);
  const meaning = entry?.[1] || (isWholeSentence
    ? sentence.meaning
    : isCrossSentence
      ? "这次选区跨了多句话。请缩短到一个词组或单句，再查看针对性解释。"
      : "当前示例尚未收录这段选文的解释。试着选中更短的词组，或展开句子结构查看拆解。");
  return { ...target, sentence, entry, kind, meaning, hasMeaning, isWholeSentence, isCrossSentence };
}
function renderStructure(target) {
  const details = $("#structure-details");
  const list = $("#sentence-parts");
  const sentencesInRange = target.isCrossSentence
    ? sentences.slice(target.startIdx, target.endIdx + 1)
    : [target.sentence];
  const parts = sentencesInRange.flatMap(sentence => sentence.parts || []);
  details.hidden = parts.length === 0;
  details.open = false;
  list.replaceChildren(...parts.map(([text, explanation]) => {
    const item = document.createElement("li");
    const phrase = document.createElement("strong");
    phrase.textContent = text;
    const note = document.createElement("p");
    note.textContent = explanation;
    item.append(phrase, note);
    return item;
  }));
}
function openHelp(target) {
  resumeReadingAfterHelp = playing;
  if (playing) stopSpeech();
  helpTarget = describeSelection(target);
  card.dataset.kind = helpTarget.kind;
  $("#help-kind").textContent = !helpTarget.hasMeaning
    ? (helpTarget.isCrossSentence ? "选区过长" : "示例尚未收录")
    : helpTarget.kind === "sentence"
      ? "Sentence"
      : helpTarget.kind === "word" ? "In this context" : "Expression";
  $("#help-title").textContent = helpTarget.text;
  $("#help-title").lang = "en";
  $("#pronunciation").textContent = helpTarget.entry?.[0] || "";
  $("#pronunciation").hidden = !helpTarget.entry?.[0];
  $("#help-meaning").textContent = helpTarget.meaning;
  $("#help-meaning").lang = helpTarget.hasMeaning ? "en" : "zh-CN";
  $("#help-audio").textContent = helpTarget.kind === "sentence" ? "听这句" : "听选中内容";
  renderStructure(helpTarget);
  updateSaveButton();
  focusReturnTarget = prose;
  hideSelectionAction();
  card.showModal();
  card.scrollTop = 0;
  positionHelpCard();
  $("#close-help").focus({ preventScroll: true });
}
function inspectSelection() {
  if (pointerDown || card.open || $("#saved-dialog").open) return;
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    selectionSignature = "";
    dismissedSelectionSignature = "";
    hideSelectionAction();
    return;
  }
  const range = selection.getRangeAt(0);
  const start = sentenceOf(range.startContainer);
  const end = sentenceOf(range.endContainer);
  if (!start || !end || !prose.contains(start) || !prose.contains(end)) {
    hideSelectionAction();
    return;
  }
  const text = selection.toString().trim().replace(/\s+/g, " ");
  if (!text || !/[a-z]/i.test(text)) {
    hideSelectionAction();
    return;
  }
  const startIdx = Number(start.dataset.idx);
  const endIdx = Number(end.dataset.idx);
  const signature = `${startIdx}:${endIdx}:${range.startOffset}:${range.endOffset}:${text}`;
  if (signature === dismissedSelectionSignature) {
    hideSelectionAction();
    return;
  }
  dismissedSelectionSignature = "";
  if (signature === selectionSignature && !$("#selection-action").hidden) return;
  selectionSignature = signature;
  selectionTarget = { text, startIdx, endIdx, signature, range: range.cloneRange(), rect: copyRect(range.getBoundingClientRect()) };
  positionSelectionAction(selectionTarget.rect);
}
prose.addEventListener("pointerdown", () => { pointerDown = true; });
document.addEventListener("pointerup", () => {
  pointerDown = false;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(inspectSelection, 40);
});
document.addEventListener("pointercancel", () => { pointerDown = false; });
document.addEventListener("selectionchange", () => {
  if (pointerDown || card.open) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(inspectSelection, 220);
});
document.addEventListener("pointerdown", (event) => {
  if (!prose.contains(event.target) && !$("#selection-action").contains(event.target)) hideSelectionAction();
  if (!$(".menu-wrap").contains(event.target)) closeTypeMenu(false);
});
$("#selection-action").addEventListener("click", (event) => {
  event.preventDefault();
  if (selectionTarget) openHelp(selectionTarget);
});
$("#close-help").addEventListener("click", () => closeHelp(true));
card.addEventListener("click", (event) => {
  if (event.target !== card) return;
  const rect = card.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeHelp(true);
});
card.addEventListener("close", () => {
  dismissedSelectionSignature = helpTarget?.signature || selectionSignature;
  hideSelectionAction();
  const returnTarget = focusReturnTarget || prose;
  focusReturnTarget = null;
  if (helpSpeechActive) {
    speechGeneration++;
    synth?.cancel();
    helpSpeechActive = false;
  }
  const resumeReading = resumeReadingAfterHelp;
  resumeReadingAfterHelp = false;
  returnTarget.focus({ preventScroll: true });
  if (resumeReading && synth) speakSentence();
});
$("#structure-details").addEventListener("toggle", positionHelpCard);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !card.open && !document.querySelector("dialog[open]")) {
    hideSelectionAction();
    closeTypeMenu(true);
  }
});
window.addEventListener("scroll", hideSelectionAction, true);
window.addEventListener("resize", () => {
  if (card.open && helpTarget) {
    helpTarget.rect = copyRect(helpTarget.range.getBoundingClientRect());
    positionHelpCard();
  } else if (selectionTarget) {
    selectionTarget.rect = copyRect(selectionTarget.range.getBoundingClientRect());
    positionSelectionAction(selectionTarget.rect);
  }
});
window.addEventListener("blur", () => { pointerDown = false; hideSelectionAction(); });

function persistSaved() {
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { toast("浏览器不允许保存，收藏仅在本次页面内有效"); }
  updateSaveButton();
}
$("#save-word").addEventListener("click", () => {
  if (!helpTarget?.hasMeaning) return;
  const exists = saved.some(item => item.text === helpTarget.text);
  saved = exists ? saved.filter(item => item.text !== helpTarget.text) : [...saved, { text: helpTarget.text, meaning: helpTarget.meaning }];
  persistSaved();
});
function renderSaved() {
  const list = $("#saved-list"); list.replaceChildren();
  if (!saved.length) {
    const p = document.createElement("p"); p.className = "saved-empty"; p.textContent = "遇到想留下的词句，在释义卡里点“收藏”。"; list.append(p);
  }
  for (const item of saved) {
    const row = document.createElement("div"); row.className = "saved-entry";
    const content = document.createElement("div"); content.lang = "en";
    const title = document.createElement("strong"); title.textContent = item.text;
    const meaning = document.createElement("p"); meaning.textContent = item.meaning;
    content.append(title, meaning);
    const remove = document.createElement("button"); remove.textContent = "移除"; remove.setAttribute("aria-label", `移除 ${item.text}`);
    remove.addEventListener("click", () => { saved = saved.filter(entry => entry.text !== item.text); persistSaved(); renderSaved(); $("#close-saved").focus(); });
    row.append(content, remove); list.append(row);
  }
}
$("#saved-toggle").addEventListener("click", () => { closeHelp(); renderSaved(); $("#saved-dialog").showModal(); });
$("#close-saved").addEventListener("click", () => $("#saved-dialog").close());
function closeTypeMenu(focus) {
  const wasOpen = !$("#type-menu").hidden;
  $("#type-menu").hidden = true;
  $("#type-toggle").setAttribute("aria-expanded", "false");
  if (focus && wasOpen) $("#type-toggle").focus({ preventScroll: true });
}
$("#type-toggle").addEventListener("click", () => {
  const open = $("#type-menu").hidden;
  $("#type-menu").hidden = !open;
  $("#type-toggle").setAttribute("aria-expanded", String(open));
});
$("[data-close-type]").addEventListener("click", () => closeTypeMenu(true));
document.querySelectorAll("[data-size]").forEach(button => button.addEventListener("click", () => {
  size = Math.max(18, Math.min(29, size + Number(button.dataset.size)));
  document.documentElement.style.setProperty("--reading-size", `${size}px`);
  $("#size-value").textContent = String(size);
}));
$("#line-height").addEventListener("change", event => document.documentElement.style.setProperty("--reading-height", event.target.value));
$("#finish-reading").addEventListener("click", (event) => {
  const done = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", String(done));
  event.currentTarget.textContent = done ? "已读完 · 撤销" : "标记读完";
  $("#completion-label").textContent = done ? "已完成这篇节选" : "开篇节选结束";
});

let activeIdx = 0;
let playing = false;
let rate = 1;
let speechGeneration = 0;
let helpSpeechActive = false;
const synth = window.speechSynthesis;
function updatePlayer() {
  $(".player").classList.toggle("is-playing", playing);
  $("#play").setAttribute("aria-label", playing ? "暂停朗读" : "开始朗读");
  $("#play-state").textContent = playing ? "正在朗读" : activeIdx ? "继续朗读" : "朗读原文";
  $("#progress").value = activeIdx;
  $("#sentence-position").textContent = `${activeIdx + 1} / ${sentences.length}`;
  prose.querySelectorAll(".is-speaking").forEach(span => span.classList.remove("is-speaking"));
  if (playing) sentenceElement(activeIdx).classList.add("is-speaking");
  $("#previous").disabled = activeIdx === 0;
  $("#next").disabled = activeIdx === sentences.length - 1;
}
function stopSpeech() { speechGeneration++; synth?.cancel(); playing = false; updatePlayer(); }
function utterance(text) {
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = "en-US"; speech.rate = rate;
  const voice = synth.getVoices().find(voice => /^en[-_]/i.test(voice.lang));
  if (voice) speech.voice = voice;
  return speech;
}
function speakSentence() {
  const generation = ++speechGeneration;
  synth.cancel(); playing = true; updatePlayer();
  const speech = utterance(sentences[activeIdx].text);
  speech.onend = () => {
    if (generation !== speechGeneration) return;
    if (activeIdx < sentences.length - 1) { activeIdx++; speakSentence(); }
    else { playing = false; activeIdx = 0; updatePlayer(); }
  };
  speech.onerror = event => {
    if (generation !== speechGeneration || event.error === "canceled" || event.error === "interrupted") return;
    playing = false; updatePlayer(); toast("系统语音不可用，请检查英语语音包");
  };
  synth.speak(speech);
}
function speakHelpText(text) {
  if (!synth) { toast("当前浏览器不支持系统朗读"); return; }
  const generation = ++speechGeneration;
  synth.cancel();
  playing = false;
  updatePlayer();
  helpSpeechActive = true;
  const speech = utterance(text);
  speech.onend = () => {
    if (generation !== speechGeneration) return;
    helpSpeechActive = false;
  };
  speech.onerror = event => {
    if (generation !== speechGeneration || event.error === "canceled" || event.error === "interrupted") return;
    helpSpeechActive = false;
    toast("系统语音不可用，请检查英语语音包");
  };
  synth.speak(speech);
}
$("#play").addEventListener("click", () => { if (playing) stopSpeech(); else if (synth) speakSentence(); else toast("当前浏览器不支持系统朗读"); });
$("#help-audio").addEventListener("click", () => { if (helpTarget) speakHelpText(helpTarget.text); });
function seek(index) {
  const resume = playing;
  stopSpeech(); activeIdx = Math.max(0, Math.min(sentences.length - 1, index)); updatePlayer();
  if (resume) speakSentence();
}
$("#previous").addEventListener("click", () => seek(activeIdx - 1));
$("#next").addEventListener("click", () => seek(activeIdx + 1));
$("#progress").max = String(sentences.length - 1);
$("#progress").addEventListener("input", event => seek(Number(event.target.value)));
$("#speed").addEventListener("click", event => {
  const speeds = [.8, 1, 1.2, 1.5]; rate = speeds[(speeds.indexOf(rate) + 1) % speeds.length];
  event.currentTarget.textContent = `${rate.toFixed(1)}×`;
  event.currentTarget.setAttribute("aria-label", `朗读速度 ${rate} 倍`);
  if (playing) speakSentence();
});
$("#player-expand").addEventListener("click", event => {
  const open = $("#player-details").hidden;
  $("#player-details").hidden = !open;
  event.currentTarget.setAttribute("aria-expanded", String(open));
  event.currentTarget.setAttribute("aria-label", open ? "收起朗读控制" : "展开朗读控制");
});
window.addEventListener("pagehide", stopSpeech);
updateSaveButton();
updatePlayer();
