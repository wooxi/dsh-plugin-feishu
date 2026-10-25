/**
 * Feishu CardKit 2.0 卡片构建。
 *
 * 视觉与结构对齐官方 larksuite/openclaw-lark（`src/card/builder.ts`）与
 * hermes-lark-streaming（`cardkit/builder.py`）：
 *
 * - 流式阶段：带 loading 图标的骨架卡，正文元素固定 id 供 typewriter 更新
 * - 完成阶段：整卡替换成 header + 折叠面板 + 正文 + footer 的成品卡
 * - 元素普遍带 `text_size` / `margin` / `icon` / `border`，否则默认样式很挤
 */

import { optimizeMarkdownStyle, splitLongText } from './markdown-style.js';

/** 流式正文元素 id（字母开头、仅字母数字下划线、≤20 字符）。 */
export const STREAMING_ELEMENT_ID = 'streaming_content';
export const REASONING_ELEMENT_ID = 'reasoning_content';
export const TOOL_PANEL_ELEMENT_ID = 'tool_panel';

/** 官方使用的旋转 loading 图标。 */
const LOADING_IMG_KEY = 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';

const LOCALES = ['zh_cn', 'en_us'];

/** 卡片文案（英文在前，附带中文 i18n）。 */
const T = {
  processing: ['Processing...', '处理中...'],
  processingPrefix: ['💭 Processing...', '💭 处理中...'],
  completed: ['✅ Completed', '✅ 已完成'],
  error: ['❌ Error', '❌ 出错'],
  stopped: ['🛑 Stopped', '🛑 已停止'],
  toolUse: ['Tool use', '工具执行'],
  thinkingPanel: ['Thinking', '思考中'],
  thought: ['Thought', '思考了'],
  done: ['Done.', '完成。'],
};

const i18n = (en, zh) => ({ zh_cn: zh, en_us: en });
const t = (key) => i18n(...T[key]);

/**
 * 时间格式化：820 → "0.8s"，65200 → "1m 5s"。
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** 紧凑数字：1234 → "1.2k"。 */
export function compactNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// 通用元素
// ---------------------------------------------------------------------------

/**
 * 折叠面板。飞书里想做出「灰框 + 右侧箭头」的观感，必须把
 * border / padding / icon / icon_expanded_angle 全部显式写出来。
 */
function collapsiblePanel({ expanded, titleEl, elements, verticalSpacing = '4px' }) {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: titleEl,
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px', color: 'grey' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: verticalSpacing,
    padding: '8px 8px 8px 8px',
    elements,
  };
}

/** 正文流式元素：固定 element_id，供 typewriter 逐字更新。 */
function streamingElement({ content = '', elementId = STREAMING_ELEMENT_ID }) {
  return {
    tag: 'markdown',
    content,
    text_align: 'left',
    text_size: 'normal_v2',
    margin: '0px 0px 0px 0px',
    element_id: elementId,
  };
}

/** 首帧的旋转 loading 图标。 */
function loadingElement() {
  return {
    tag: 'markdown',
    content: ' ',
    icon: { tag: 'custom_icon', img_key: LOADING_IMG_KEY, size: '16px 16px' },
  };
}

/** 卡片 header：蓝=处理中，绿=完成，红=出错/停止。 */
function buildHeader(status) {
  const map = {
    streaming: ['processingPrefix', 'blue'],
    completed: ['completed', 'green'],
    failed: ['error', 'red'],
    stopped: ['stopped', 'red'],
  };
  const [key, template] = map[status] ?? map.completed;
  const [en, zh] = T[key];
  return { title: { tag: 'plain_text', content: en, i18n_content: i18n(en, zh) }, template };
}

// ---------------------------------------------------------------------------
// 思考 / 工具面板
// ---------------------------------------------------------------------------

/** 思考面板。流式中展开，完成后折叠。 */
function buildReasoningPanel({ text = '', elapsedMs = 0, expanded = false }) {
  const dur = formatElapsed(elapsedMs);
  const [enBase, zhBase] = text.trim() ? T.thought : T.thinkingPanel;
  const en = dur ? `${enBase} ${dur}` : enBase;
  const zh = dur ? `${zhBase} ${dur}` : zhBase;

  return collapsiblePanel({
    expanded,
    titleEl: {
      tag: 'plain_text',
      content: `💭 ${en}`,
      i18n_content: i18n(`💭 ${en}`, `💭 ${zh}`),
      text_color: 'grey',
      text_size: 'notation',
    },
    elements: [{ tag: 'markdown', content: text || '...', text_size: 'notation' }],
    verticalSpacing: '8px',
  });
}

const TOOL_STATUS = {
  running: [['Running', '执行中'], 'turquoise'],
  success: [['Succeeded', '已完成'], 'green'],
  error: [['Failed', '失败'], 'red'],
};

function buildToolStepElements(step) {
  const [labels, color] = TOOL_STATUS[step.status] ?? [['', ''], 'grey'];
  const [enLabel, zhLabel] = labels;
  const title = step.title || step.name || 'tool';
  const out = [
    {
      tag: 'div',
      icon: { tag: 'standard_icon', token: step.icon || 'tool_02', color: 'grey' },
      text: {
        tag: 'lark_md',
        content: `**${title}** · <font color='${color}'>${zhLabel}</font>`,
        text_size: 'notation',
      },
    },
  ];

  if (step.detail) {
    out.push({
      tag: 'div',
      margin: '0px 0px 0px 22px',
      text: { tag: 'plain_text', content: step.detail, text_color: 'grey', text_size: 'notation' },
    });
  }

  const block = step.errorBlock || step.resultBlock;
  if (block) {
    const label = step.errorBlock ? '**Error**' : '**Result**';
    out.push({
      tag: 'div',
      margin: '0px 0px 0px 22px',
      text: {
        tag: 'lark_md',
        content: `${label}\n\`\`\`${block.language || 'text'}\n${block.content}\n\`\`\``,
        text_size: 'notation',
      },
    });
  }

  return out;
}

/** 工具执行面板。steps 为空时给一个占位面板。 */
function buildToolPanel({ steps = [], elapsedMs = 0, expanded = false }) {
  const [enBase, zhBase] = T.toolUse;
  const enParts = [enBase];
  const zhParts = [zhBase];
  if (steps.length) {
    enParts.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
    zhParts.push(`${steps.length} 步`);
  }
  const dur = formatElapsed(elapsedMs);
  if (dur) {
    enParts.push(`(${dur})`);
    zhParts.push(`(${dur})`);
  }

  return collapsiblePanel({
    expanded,
    titleEl: {
      tag: 'plain_text',
      content: `🛠️ ${enParts.join(' · ')}`,
      i18n_content: i18n(`🛠️ ${enParts.join(' · ')}`, `🛠️ ${zhParts.join(' · ')}`),
      text_color: 'grey',
      text_size: 'notation',
    },
    elements: steps.length
      ? steps.flatMap(buildToolStepElements)
      : [
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: 'No tool steps yet',
              i18n_content: i18n('No tool steps yet', '暂无工具步骤'),
              text_color: 'grey',
              text_size: 'notation',
            },
          },
        ],
  });
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * 底部统计行（单行）：`✅ 已完成 · 12.3s · claude-sonnet · 1.2k tokens · 缓存 45%`。
 */
function buildFooterElements({ metrics = {}, isError = false, isAborted = false }) {
  const statusKey = isError ? 'error' : isAborted ? 'stopped' : 'completed';
  const [enStatus, zhStatus] = T[statusKey];

  const enPrimary = [enStatus];
  const zhPrimary = [zhStatus];

  const dur = formatElapsed(metrics.elapsedMs);
  if (dur) {
    enPrimary.push(dur);
    zhPrimary.push(dur);
  }
  if (metrics.model) {
    enPrimary.push(metrics.model);
    zhPrimary.push(metrics.model);
  }

  const enDetail = [];
  const zhDetail = [];
  if (metrics.totalTokens) enDetail.push(`${compactNumber(metrics.totalTokens)} tokens`);
  if (metrics.cacheHitRate != null) {
    const pct = `${Math.round(metrics.cacheHitRate * 100)}%`;
    enDetail.push(`cache ${pct}`);
    zhDetail.push(`缓存 ${pct}`);
  }
  if (metrics.totalTokens) zhDetail.unshift(`${compactNumber(metrics.totalTokens)} tokens`);

  // 单行紧凑排布：状态 · 耗时 · 模型 · tokens · 缓存。
  // 飞书卡片 markdown 单个 \n 不换行、\n\n 会撑出空段，一行到底最干净。
  const enSegments = [...enPrimary, ...enDetail].filter(Boolean);
  const zhSegments = [...zhPrimary, ...zhDetail].filter(Boolean);
  if (!enSegments.length) return [];

  let enContent = enSegments.join(' · ');
  let zhContent = zhSegments.join(' · ');
  if (isError) {
    enContent = `<font color='red'>${enContent}</font>`;
    zhContent = `<font color='red'>${zhContent}</font>`;
  }

  return [
    { tag: 'hr' },
    { tag: 'markdown', content: enContent, i18n_content: i18n(enContent, zhContent), text_size: 'notation' },
  ];
}

/** 从正文抽一句话做消息列表预览（去掉 markdown 符号）。 */
function buildSummary(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain ? { content: plain.slice(0, 120) } : undefined;
}

// ---------------------------------------------------------------------------
// 对外：阶段卡片
// ---------------------------------------------------------------------------

/**
 * 流式阶段骨架卡：header + loading 图标 + 空的正文元素。
 *
 * 正文先用空串占位，后续靠 `cardElement.content()` 逐字灌进来；
 * loading 图标在收尾时会被整卡替换掉。
 *
 * @param {object} [options]
 * @param {boolean} [options.withToolPanel]
 * @param {boolean} [options.withHeader]
 * @returns {object} CardKit 2.0 卡片 JSON
 */
export function buildStreamingCard({ withToolPanel = true, withHeader = false } = {}) {
  const elements = [];
  if (withToolPanel) elements.push(buildToolPanel({ expanded: false }));
  elements.push(streamingElement({ content: '' }));
  elements.push(loadingElement());

  const card = {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 15 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
      locales: LOCALES,
      summary: { content: T.processing[0], i18n_content: t('processing') },
    },
    body: { elements },
  };
  if (withHeader) card.header = buildHeader('streaming');
  return card;
}

/**
 * 完成态卡片：整卡替换用。
 *
 * 顺序 = 工具面板 → 思考面板 → 正文 → footer，与官方一致：
 * 过程信息在上、结论在中、统计在下。
 *
 * @param {object} [options]
 * @returns {object}
 */
export function buildCompleteCard({
  text = '',
  reasoningText = '',
  reasoningElapsedMs = 0,
  toolSteps = [],
  toolElapsedMs = 0,
  elapsedMs = 0,
  model = '',
  totalTokens = 0,
  cacheHitRate = null,
  isError = false,
  isAborted = false,
  showToolUse = true,
  // 官方卡片不带 header：状态由 footer 第一行表达。
  withHeader = false,
} = {}) {
  const elements = [];

  if (showToolUse) {
    elements.push(buildToolPanel({ steps: toolSteps, elapsedMs: toolElapsedMs, expanded: false }));
  }

  if (reasoningText && reasoningText.trim()) {
    elements.push(buildReasoningPanel({ text: reasoningText, elapsedMs: reasoningElapsedMs, expanded: false }));
  }

  const body = optimizeMarkdownStyle(text) || (isError ? '执行失败。' : T.done[1]);
  for (const chunk of splitLongText(body)) {
    if (chunk.trim()) elements.push({ tag: 'markdown', content: chunk, text_size: 'normal_v2' });
  }

  elements.push(
    ...buildFooterElements({
      metrics: { elapsedMs, model, totalTokens, cacheHitRate },
      isError,
      isAborted,
    }),
  );

  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true, locales: LOCALES },
    body: { elements },
  };
  const summary = buildSummary(text);
  if (summary) card.config.summary = summary;
  if (withHeader) {
    card.header = buildHeader(isError ? 'failed' : isAborted ? 'stopped' : 'completed');
  }
  return card;
}
