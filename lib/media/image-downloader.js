import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Download an image from Feishu and save it to local storage for DSH multimodal ingestion.
 * @param {object} param
 * @param {object} param.transport - Lark transport instance
 * @param {string} param.messageId - Feishu message ID
 * @param {string} param.imageKey - Feishu image_key / file_key
 * @param {string} [param.saveDir] - Destination directory
 * @returns {Promise<string>} Local file path
 */
export async function downloadLarkImage({ transport, messageId, imageKey, saveDir = tmpdir() }) {
  if (!imageKey) {
    throw new Error('Missing imageKey');
  }

  mkdirSync(saveDir, { recursive: true });
  const localFileName = `${imageKey}.png`;
  const targetPath = resolve(saveDir, localFileName);

  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`;

  let bufferData;

  if (transport && typeof transport.fetchResource === 'function') {
    const res = await transport.fetchResource(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch lark resource: ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    bufferData = Buffer.from(ab);
  } else {
    const token = await transport.getTenantAccessToken();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to download lark image [${res.status}]: ${res.statusText}`);
    }
    const ab = await res.arrayBuffer();
    bufferData = Buffer.from(ab);
  }

  writeFileSync(targetPath, bufferData);
  return targetPath;
}
