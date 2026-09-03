/**
 * 生成 UI 设计预览页（静态）。用法：
 *   node scripts/gen-ui-preview.mjs
 * 产出 immersive-translator-windows/ui-preview.html
 * 作用：读取 src/styles.css 内联进独立 HTML，按设计系统画出各窗口的静态样板，
 *       便于不启动 Rust/桌面端时快速目检新界面。仅供预览，不参与应用构建。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "src/styles.css"), "utf8");

// ---- 静态 SVG 图标（与 src/ui/icons.tsx 同构，预览用） ----
const I = {
  translate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7"/><path d="M9 3v2c0 4.97-3 8-7 8"/><path d="M5 9c0 2 1.5 4 4 5"/><path d="M14 21l4-10 4 10"/><path d="M15.5 18h5"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  copyAll: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/><path d="M21 3l-9 9"/><path d="M3 21l9-9"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  settings: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  crop: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
  retry: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  stop: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  down: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
};
const ic = (name, cls = "") => `<span class="${cls}">${I[name]}</span>`;

// ---- 页面骨架 ----
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ImmersiveTranslator · 新版 UI 预览</title>
<style>
${css}
/* —— 预览页专用：允许滚动、灰底 —— */
html, body { background: #e9ebf2 !important; overflow: auto !important; }
.preview-wrap { max-width: 1180px; margin: 0 auto; padding: 28px 24px 80px; }
.preview-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.preview-head h1 { font-size:18px; margin:0; }
.preview-head .tag { font-size:11px; color:#fff; background:var(--accent-grad); padding:3px 10px; border-radius:999px; }
.preview-sub { color:var(--text-3); font-size:12.5px; margin-bottom:26px; }
.block-label { font-size:12px; font-weight:700; color:var(--text-3); text-transform:uppercase; letter-spacing:.05em; margin:28px 0 10px; display:flex; align-items:center; gap:8px; }
.block-label::before { content:""; width:14px; height:2px; background:var(--accent); border-radius:2px; display:inline-block; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); gap:20px; align-items:start; }
/* 浮窗放在深色底上突出阴影 */
.stage { background:linear-gradient(160deg,#dfe3ee,#d3d8e6); border-radius:16px; padding:26px; display:flex; justify-content:center; }
.preview-panel { width:100%; max-width:440px; height:320px; }
.settings-card-lg { padding:16px 18px; }
</style>
</head>
<body>
<div class="preview-wrap">
  <div class="preview-head"><h1>ImmersiveTranslator · 新版 UI 预览</h1><span class="tag">Windows · 设计稿</span></div>
  <div class="preview-sub">样式直接读取 <code>src/styles.css</code> 生成；图标为静态 SVG 近似。真机效果请运行 <code>npm run tauri dev</code>。</div>

  <div class="block-label">翻译浮窗 · 已完成 / 流式翻译中 / 出错</div>
  <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
    <div class="stage"><div class="preview-panel panel-root">${donePanel()}</div></div>
    <div class="stage"><div class="preview-panel panel-root">${streamingPanel()}</div></div>
    <div class="stage"><div class="preview-panel panel-root">${errorPanel()}</div></div>
  </div>

  <div class="block-label">设置窗口</div>
  <div class="settings-page" style="border-radius:16px;overflow:hidden;border:1px solid var(--border);box-shadow:var(--shadow-float);height:auto;max-height:780px">
    <div class="settings-inner" style="max-width:none">${settingsSections()}</div>
  </div>

  <div class="block-label">历史窗口</div>
  <div class="history-page" style="border-radius:16px;overflow:hidden;border:1px solid var(--border);box-shadow:var(--shadow-float)">
    ${historyToolbar()}
    ${historyBulkBar()}
    <div class="history-list" style="max-height:340px">${historyCards()}</div>
  </div>

  <div class="block-label">确认弹窗（替代原生 confirm）</div>
  <div style="position:relative;height:250px;border-radius:16px;overflow:hidden;border:1px solid var(--border);background:var(--bg)">
    <div class="modal-overlay" style="position:absolute;animation:none">
      <div class="modal">
        <div class="modal-title danger"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>删除这条记录</div>
        <div class="modal-body">将永久删除这条记录，此操作不可撤销。</div>
        <div class="modal-actions">
          <button class="btn btn-secondary">取消</button>
          <button class="btn btn-danger-solid">删除</button>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

function donePanel() {
  return `
    <header class="panel-header">
      <div class="panel-title" style="cursor:default">
        <span class="panel-logo">${I.translate.replace('width="16"','width="13"')}</span>
        <span class="app-name">ImmersiveTranslator</span>
        <span class="chip chip-blue">选中</span>
      </div>
      <div class="panel-actions">
        <button class="icon-btn" title="复制原文+译文">${I.copyAll}</button>
        <button class="icon-btn" title="收藏">${I.star}</button>
        <button class="icon-btn" title="固定浮窗">${I.pin}</button>
        <button class="icon-btn" title="翻译历史">${I.clock}</button>
        <button class="icon-btn" title="设置">${I.settings}</button>
        <button class="icon-btn" title="关闭">${I.close}</button>
      </div>
    </header>
    <div class="panel-body" style="overflow:auto">
      <div class="orig-block"><div class="orig-label">原文 · 选中</div>
        <div class="orig-text">The quick brown fox jumps over the lazy dog. 人工智能正在改变我们与信息交互的方式。</div></div>
      <div class="trans-block">
        <div class="trans-row"><div class="trans-label">${I.translate.replace('width="16"','width="11"')} 译文</div>
          <div class="trans-actions"><button class="btn btn-secondary btn-sm">${I.copy} 复制译文</button></div></div>
        <div class="trans-text">敏捷的棕色狐狸跃过懒狗。人工智能正在重塑我们与信息互动的方式，让阅读与理解不再有边界。</div>
      </div>
      <div class="panel-meta">
        <span>总耗时 <strong>1.8s</strong></span>
        <span class="meta-break">连接 320ms · 首字 1.1s</span>
      </div>
    </div>
    <div class="toast" style="position:absolute;left:50%;bottom:14px;transform:translateX(-50%)">${I.check} 已复制译文</div>`;
}

function errorPanel() {
  return `
    <header class="panel-header">
      <div class="panel-title" style="cursor:default">
        <span class="panel-logo">${I.translate.replace('width="16"','width="13"')}</span>
        <span class="app-name">ImmersiveTranslator</span>
        <span class="chip chip-blue">选中</span>
      </div>
      <div class="panel-actions">
        <button class="icon-btn active" title="重试">${I.retry}</button>
        <button class="icon-btn" title="固定浮窗">${I.pin}</button>
        <button class="icon-btn" title="翻译历史">${I.clock}</button>
        <button class="icon-btn" title="设置">${I.settings}</button>
        <button class="icon-btn" title="关闭">${I.close}</button>
      </div>
    </header>
    <div class="panel-body">
      <div class="orig-block"><div class="orig-label">原文 · 选中</div>
        <div class="orig-text">Some long text that could not be translated this time due to a service outage.</div></div>
      <div class="error-block">
        <div class="error-title">${I.alert} 翻译失败</div>
        <div class="error-text">HTTP 429 · 请求过多（rate limit）。服务商限流，请稍后重试，或检查套餐额度。</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary btn-sm">${I.retry} 重试</button>
        <button class="btn btn-secondary btn-sm">去设置检查</button>
      </div>
    </div>`;
}

function streamingPanel() {
  return `
    <header class="panel-header">
      <div class="panel-title" style="cursor:default">
        <span class="panel-logo">${I.translate.replace('width="16"','width="13"')}</span>
        <span class="app-name">ImmersiveTranslator</span>
        <span class="dot-pulse"></span>
      </div>
      <div class="panel-actions">
        <button class="icon-btn" title="取消请求">${I.stop}</button>
        <button class="icon-btn" title="固定浮窗">${I.pin}</button>
        <button class="icon-btn" title="翻译历史">${I.clock}</button>
        <button class="icon-btn" title="设置">${I.settings}</button>
        <button class="icon-btn" title="关闭">${I.close}</button>
      </div>
    </header>
    <div class="panel-body">
      <div class="orig-block"><div class="orig-label">原文 · OCR</div>
        <div class="orig-text">Neural networks learn by adjusting millions of weights through backpropagation.</div></div>
      <div class="loading-line"><span class="spinner"></span>翻译中…<span class="mono-ms">1.2s</span></div>
      <div class="trans-block">
        <div class="trans-label">译文</div>
        <div class="trans-text caret">神经网络通过反向传播调整数百万个权重来学习，这是一个不断逼近目标的过程，也是深度学习成功的</div>
      </div>
    </div>`;
}

function settingsSections() {
  const providers = [
    ["openai","O","OpenAI · GPT-4o Mini","gpt-4o-mini",false,true],
    ["deepseek","D","DeepSeek V3","deepseek-chat",false,false],
    ["zhipu","智","智谱 · GLM-4 Flash","glm-4-flash",false,false],
    ["gemini","G","Google · Gemini Flash","gemini-2.0-flash",false,false],
    ["ollama","本","本地 · Ollama","llama3.2",true,false],
    ["lmstudio","本","本地 · LM Studio","model-identifier",true,false],
  ];
  const logoBg = {
    openai:"linear-gradient(135deg,#10a37f,#0d8a6c)",deepseek:"linear-gradient(135deg,#4d6bfe,#3b4fc0)",
    zhipu:"linear-gradient(135deg,#3859ff,#7b2bf2)",gemini:"linear-gradient(135deg,#4285f4,#9b72cb)",
    ollama:"linear-gradient(135deg,#555,#888)",lmstudio:"linear-gradient(135deg,#5b9bf8,#3a6fd8)",
  };
  const cards = providers.map(([id,ch,name,model,free,active]) => `
    <div class="preset-card${active?" active":""}" style="cursor:default">
      <div class="preset-top">
        <span class="preset-logo" style="background:${logoBg[id]}">${ch}</span>
        <div style="min-width:0;flex:1"><div class="preset-name">${name}</div><div class="preset-model">${model}</div></div>
      </div>
      <div class="preset-tags">${free?'<span class="chip chip-green">免 Key</span>':'<span class="chip chip-amber">需填 Key</span>'}${active?'<span class="chip chip-blue">当前使用</span>':''}</div>
    </div>`).join("");

  return `
    <div class="page-header" style="margin-top:4px">
      <div class="panel-logo">${I.translate.replace('width="16"','width="14"')}</div>
      <h1>设置</h1><span class="version">v0.2.0</span>
    </div>

    <div class="welcome-box">
      <div class="welcome-title">欢迎使用 ImmersiveTranslator</div>
      <div class="welcome-body">1. 选一个服务商（国内直连推荐 <strong>DeepSeek</strong> 或 <strong>智谱</strong>）。<br/>2. 填入对应 <strong>API Key</strong>（本地 Ollama / LM Studio 可留空）。<br/>3. 点「测试当前接口」，选中文本按热键即可翻译。</div>
      <button class="btn">我知道了</button>
    </div>

    <section class="section-card">
      <h2 class="section-title"><span class="num">1</span>翻译接口</h2>
      <div class="field-label">Provider 预设（点击套用接口 + 模型）</div>
      <div class="preset-group-label">云端服务</div>
      <div class="preset-grid">${cards.slice(0,4)}</div>
      <div class="preset-group-label">本地模型（免 Key）</div>
      <div class="preset-grid">${cards.slice(4)}</div>
      <div class="form-divider"></div>
      <label class="field-label" style="display:block">接口地址（OpenAI 兼容）
        <input class="input mono" value="https://api.openai.com/v1/chat/completions" readonly></label>
      <label class="field-label" style="display:block;margin-top:10px">API Key（DPAPI 加密保存）
        <span class="input-group"><input class="input mono" type="password" value="sk-proj-****************************" readonly>
        <button class="icon-btn input-append" style="height:22px;width:22px" title="显示 Key">${I.eye}</button></span>
      </label>
      <label class="field-label" style="display:block;margin-top:10px">模型<input class="input mono" value="gpt-4o-mini" readonly></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-secondary">${I.retry} 测试当前接口</button>
        <button class="btn btn-ghost">${I.copy} 复制脱敏 curl</button>
        <button class="btn btn-ghost">生成诊断报告</button>
      </div>
      <div class="msg-bar ok">${I.check} 连接成功 · 模型响应正常（320ms）</div>
    </section>

    <section class="section-card">
      <h2 class="section-title"><span class="num">2</span>翻译语言与行为</h2>
      <div class="form-row" style="align-items:flex-start">
        <div style="flex:1">
          <div class="field-label">翻译模式</div>
          <div class="seg"><button class="active">自动</button><button>固定目标语言</button></div>
          <p class="hint">中文 → English，其他语言 → 简体中文</p>
        </div>
        <label class="form-col field-label" style="margin:0">固定目标语言<input class="input" style="margin-top:6px" value="日本語" readonly disabled></label>
      </div>
      <div class="form-divider"></div>
      <label class="form-row field-label" style="margin:0;cursor:pointer"><input type="checkbox" checked><span>流式输出<span class="hint" style="margin:0">边翻译边显示；关闭则等全部完成再显示</span></span></label>
      <div class="form-divider"></div>
      <label class="field-label" style="display:block">自定义翻译风格（可选）<textarea class="textarea" style="min-height:54px;margin-top:6px" placeholder="例如：使用自然口语化的风格；保留专有名词不翻译"></textarea></label>
    </section>

    <div class="save-bar" style="margin-top:16px">
      <button class="btn btn-ghost" style="color:var(--err)">恢复默认</button>
      <span class="hint-ok" style="display:inline-flex;gap:4px;align-items:center">${I.check} 已保存</span>
      <div style="flex:1"></div>
      <button class="btn btn-secondary">${I.close} 关闭</button>
      <button class="btn btn-primary">${I.check} 保存设置</button>
    </div>`;
}

function historyToolbar() {
  return `
    <div class="history-toolbar">
      <div class="search-box">${I.search}<input class="input" placeholder="搜索原文 / 译文 / 语言，或输入「收藏」「ocr」" readonly></div>
      <div class="seg"><button class="active">全部</button><button>${I.star.replace('width="14"','width="12"')} 收藏</button></div>
      <div style="flex:1"></div><span style="font-size:12px;color:var(--text-3)">128 条</span>
    </div>
    <div class="history-subbar"><span>导出 / 复制：</span>
      <button class="btn btn-ghost btn-sm">CSV</button><button class="btn btn-ghost btn-sm">JSON</button>
      <button class="btn btn-ghost btn-sm">Markdown</button><button class="btn btn-ghost btn-sm">纯文本</button>
      <div style="flex:1"></div>
      <button class="btn btn-ghost btn-sm" style="color:var(--err)">${I.trash} 清空未收藏</button>
    </div>`;
}

function historyBulkBar() {
  return `
    <div class="history-subbar" style="background:var(--accent-softer);border-top:none">
      <span style="color:var(--accent);font-weight:600">已选 2 条</span>
      <div style="flex:1"></div>
      <button class="btn btn-secondary btn-sm">${I.copy} 复制所选译文</button>
      <button class="btn btn-outline-danger btn-sm">${I.trash} 删除所选</button>
    </div>`;
}

function historyCards() {
  const mk = (isOcr, lang, time, model, orig, trans, sel = false) => `
    <div class="history-card${sel?" selected":""}">
      <div class="meta">
        <input type="checkbox" class="hist-select" ${sel?"checked":""}>
        <span class="chip ${isOcr?"chip-amber":"chip-blue"}">${isOcr?I.crop:I.search} ${isOcr?"OCR":"选中"}</span>
        <span class="lang">${lang}</span><span>${time}</span><span class="model">${model}</span>
        <span class="chip chip-gray">1.8s</span><span class="spacer"></span>
        <div class="actions">
          <button class="icon-btn" title="复制译文">${I.copy}</button>
          <button class="icon-btn" title="复制原文+译文">${I.copyAll}</button>
          <button class="icon-btn active" title="取消收藏">${I.star}</button>
          <button class="icon-btn" style="color:var(--err)" title="删除">${I.trash}</button>
        </div>
      </div>
      <div class="orig">${orig}</div>
      <div class="trans">${trans}</div>
      <div style="display:flex;justify-content:center;margin-top:2px"><button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--text-4)">${I.down} 展开全文</button></div>
    </div>`;
  return [
    mk(true,"简体中文","2026-09-02 18:42","glm-4-flash","Neural networks learn by adjusting millions of weights through backpropagation.","神经网络通过反向传播调整数百万个权重来学习，这是深度学习成功的基石。", true),
    mk(false,"English","2026-09-02 18:12","gpt-4o-mini","沉浸式翻译的核心是低打扰：译文紧贴原文，阅读不被切断。","The essence of immersive translation is low disruption: the translation hugs the source text so reading is never interrupted.", true),
    mk(false,"简体中文","2026-09-01 22:05","deepseek-chat","The quick brown fox jumps over the lazy dog.","敏捷的棕色狐狸跃过懒狗。"),
  ].join("");
}

writeFileSync(resolve(root, "ui-preview.html"), html, "utf8");
console.log("ui-preview.html generated:", html.length, "bytes");
