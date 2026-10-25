/**
 * 日志出口：把本插件的日志按级别写到 stdout / stderr。
 *
 * 为什么必须有这个文件：
 * Cordis 的 `ctx.logger(name)` 返回的 Logger 只把消息推给已注册的 exporter；
 * 默认 exporter 仅写入内存环形 buffer（cordis/lib/index.js:582-607），
 * **不会打印到 stdout**。因此不注册 exporter 时，`logger.info(...)` 在
 * journalctl / systemd 里完全看不到——看起来像「什么都没发生」。
 *
 * 设计对照：dsh-feishu-cui lib/infra/plugin/log-exporter.js
 */

/** logger 命名空间：建 logger 用的就是这个名字。 */
export const LOGGER_NAMESPACE = 'dsh-feishu';

/** 把一个参数渲染成单行文本。 */
function render(value) {
  let text;
  if (value instanceof Error) text = value.stack ?? value.message;
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'object' && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else text = String(value);
  return text.replace(/\r?\n/g, '\\n');
}

/** 把 message.args 拼成一行。 */
function formatArgs(args) {
  const [first, ...rest] = args;
  if (typeof first !== 'string') return [first, ...rest].map(render).join(' ');
  let index = 0;
  const text = first.replace(/%[sdifjoO%]/g, (match) => {
    if (match === '%%') return '%';
    if (index >= rest.length) return match;
    index += 1;
    return render(rest[index - 1]);
  });
  const tail = rest.slice(index).map(render).join(' ');
  return tail ? `${text} ${tail}` : text;
}

/**
 * 挂上日志出口。
 *
 * @param {object} ctx Cordis 上下文
 * @param {string} [namespace] 只导出这个命名空间的日志
 */
export function registerLogExporter(ctx, namespace = LOGGER_NAMESPACE) {
  const logger = ctx?.logger;
  if (!logger || typeof logger.exporter !== 'function') return;

  try {
    logger.exporter({
      levels: { default: 2 },
      export: (message) => {
      if (message?.name !== namespace) return;
      const time = new Date(message.ts).toISOString();
      const line = `[${time}] [${message.type}] [${message.name}] ${formatArgs(message.args)}\n`;
        if (message.type === 'error') process.stderr.write(line);
        else process.stdout.write(line);
      },
    });
  } catch {
    // exporter 注册失败不影响主流程：关键节点另有 console 双写兜底。
  }
}
