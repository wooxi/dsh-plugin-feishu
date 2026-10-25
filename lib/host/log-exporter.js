export const LOGGER_NAMESPACE = 'dsh-feishu';

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
  }
}
