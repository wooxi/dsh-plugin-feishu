import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Extract markdown image definitions from agent text output
 * @param {string} text
 * @returns {Array<{ alt: string, path: string }>}
 */
export function extractMarkdownImages(text) {
  if (!text) return [];

  // Match: ![alt](path) or ![alt](<path>)
  const imgRegex = /!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)/g;
  const matches = [];
  let m;

  while ((m = imgRegex.exec(text)) !== null) {
    const alt = m[1] || '';
    const path = (m[2] || m[3] || '').trim();
    if (path) {
      matches.push({ alt, path });
    }
  }

  return matches;
}

/**
 * Upload a local image file to Feishu image library
 * @param {object} param
 * @param {object} param.transport
 * @param {string} param.filePath
 * @param {string} [param.imageType='message']
 * @returns {Promise<string>} Feishu image_key
 */
export async function uploadLocalImageToLark({ transport, filePath, imageType = 'message' }) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`Local file not found: ${filePath}`);
  }

  if (transport && typeof transport.uploadImage === 'function') {
    return await transport.uploadImage({ filePath, imageType });
  }

  const token = await transport.getTenantAccessToken();
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append('image_type', imageType);
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  formData.append('image', blob, fileName);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Upload image failed [${data.code}]: ${data.msg}`);
  }

  return data.data?.image_key;
}
