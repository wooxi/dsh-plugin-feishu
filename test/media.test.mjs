import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('Task 7: extractMarkdownImages parses local image paths correctly', async () => {
  const { extractMarkdownImages } = await import('../lib/media/image-uploader.js');

  const text = `
这里是图表说明：
![流程图](/dsh-workspace/output/flow.png)
还有一张测试截图：
![UI 效果](<./assets/screenshot.jpg>)
普通链接不是图片：[查看详情](https://example.com)
`;

  const images = extractMarkdownImages(text);
  assert.equal(images.length, 2);
  assert.equal(images[0].alt, '流程图');
  assert.equal(images[0].path, '/dsh-workspace/output/flow.png');
  assert.equal(images[1].alt, 'UI 效果');
  assert.equal(images[1].path, './assets/screenshot.jpg');
});

test('Task 7: downloadLarkImage downloads stream and writes local file', async () => {
  const { downloadLarkImage } = await import('../lib/media/image-downloader.js');

  // Mock transport returning a readable binary stream
  const mockBuffer = Buffer.from('FAKE_PNG_BINARY_DATA');
  const mockTransport = {
    getTenantAccessToken: async () => 'test_token',
    fetchResource: async (url) => ({
      ok: true,
      arrayBuffer: async () => mockBuffer.buffer,
    }),
  };

  const savedPath = await downloadLarkImage({
    transport: mockTransport,
    messageId: 'om_img_123',
    imageKey: 'img_v2_fake_key',
    saveDir: tmpdir(),
  });

  assert.ok(existsSync(savedPath), 'Saved image file must exist');
  assert.match(savedPath, /img_v2_fake_key/);

  // Clean up
  try {
    unlinkSync(savedPath);
  } catch {}
});

test('Task 7: uploadLocalImageToLark uploads file and returns image_key', async () => {
  const { uploadLocalImageToLark } = await import('../lib/media/image-uploader.js');

  const tmpFile = resolve(tmpdir(), 'test_upload_sample.png');
  writeFileSync(tmpFile, 'FAKE_PNG_CONTENT');

  const mockTransport = {
    getTenantAccessToken: async () => 'test_token',
    uploadImage: async ({ filePath, imageType }) => {
      assert.equal(filePath, tmpFile);
      assert.equal(imageType, 'message');
      return 'img_v3_uploaded_key_888';
    },
  };

  const imageKey = await uploadLocalImageToLark({
    transport: mockTransport,
    filePath: tmpFile,
  });

  assert.equal(imageKey, 'img_v3_uploaded_key_888');

  try {
    unlinkSync(tmpFile);
  } catch {}
});
