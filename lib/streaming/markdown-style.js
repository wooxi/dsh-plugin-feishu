const MAX_CARD_TABLES = 5;

export function optimizeMarkdownStyle(text) {
  if (typeof text !== 'string' || !text) return '';
  try {
    const MARK = '___CB_';
    const blocks = [];

    let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = '') => {
      const block = m.slice(String(prefix).length);
      blocks.push(block);
      return `${prefix}${MARK}${blocks.length - 1}___`;
    });

    if (/^#{1,3} /m.test(text)) {
      r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 → H5
      r = r.replace(/^# (.+)$/gm, '#### $1'); // H1 → H4
    }

    blocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });

    r = r.replace(/\n{3,}/g, '\n\n');
    return stripInvalidImageKeys(downgradeTables(r));
  } catch {
    return text;
  }
}

/**
 * 卡片里最多渲染 5 个表格，超出的降级成代码块（内容还在，只是不成表格）。
 * @param {string} text
 * @returns {string}
 */
export function downgradeTables(text, limit = MAX_CARD_TABLES) {
  try {
    const codeRanges = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => [m.index, m.index + m[0].length]);
    const inCode = (i) => codeRanges.some(([s, e]) => s <= i && i < e);

    const tables = [];
    for (const m of text.matchAll(/\|.+\|\n\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g)) {
      if (!inCode(m.index)) tables.push([m.index, m.index + m[0].length, m[0]]);
    }
    if (tables.length <= limit) return text;

    let out = text;
    for (const [start, end, raw] of tables.slice(limit).reverse()) {
      out = out.slice(0, start) + '```\n' + raw + '\n```' + out.slice(end);
    }
    return out;
  } catch {
    return text;
  }
}

/**
 * 移除非 `img_xxx` 的图片引用，避免 CardKit 200570。
 * @param {string} text
 * @returns {string}
 */
export function stripInvalidImageKeys(text) {
  if (!text.includes('![')) return text;
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (full, _alt, key) =>
    String(key).startsWith('img_') ? full : '',
  );
}

/**
 * 把超长正文切成多块（单卡 markdown 元素有长度上限）。
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitLongText(text, limit = 2400) {
  if (!text || text.length <= limit) return [text || ''];
  const chunks = [];
  let rest = text;
  while (rest) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}
