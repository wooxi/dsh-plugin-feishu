import test from 'node:test';
import assert from 'node:assert/strict';
import { generateQrSvg } from '../lib/host/qr-generator.js';
import { FeishuConfigRouter } from '../lib/host/config-router.js';
import { EventEmitter } from 'node:events';

test('Task 8 (Settings): QR Code Generator produces valid SVG', () => {
  const svg = generateQrSvg('https://open.feishu.cn', { size: 180, fgColor: '#3370ff' });
  assert.ok(svg.startsWith('<svg'), 'Should start with <svg tag');
  assert.ok(svg.includes('width="180"'), 'Should respect size option');
  assert.ok(svg.includes('#3370ff'), 'Should contain configured foreground color');
  assert.ok(svg.includes('</svg>'), 'Should end with </svg>');
});

test('Task 8 (Settings): Config Router reads config with masked secrets', async () => {
  const config = {
    appId: 'cli_test_123',
    appSecret: 'secret_abcdef123456',
    ownerId: 'ou_owner_001',
    enableCardKit: true,
  };

  const router = new FeishuConfigRouter({
    config,
    transport: { isConnected: true },
    logger: console,
  });

  let responseData = null;
  const mockRes = {
    setHeader() {},
    writeHead(status, headers) {},
    end(payload) {
      responseData = JSON.parse(payload);
    },
  };

  await router.handleGetConfig({}, mockRes);

  assert.ok(responseData, 'Response should not be null');
  assert.equal(responseData.code, 0);
  assert.equal(responseData.data.appId, 'cli_test_123');
  assert.equal(responseData.hasSecret, true);
  assert.ok(!responseData.data.appSecret, 'Raw secret should never be leaked');
  assert.ok(responseData.data.appSecretMasked.includes('••••'), 'Secret should be masked');
});

test('Task 8 (Settings): Config Router updates config and invokes callback', async () => {
  let updatedConfig = null;
  const router = new FeishuConfigRouter({
    config: { appId: 'cli_old', appSecret: 'old_sec' },
    onConfigUpdate: async (cfg) => {
      updatedConfig = cfg;
    },
  });

  const mockReq = new EventEmitter();
  let responseData = null;
  const mockRes = {
    setHeader() {},
    writeHead() {},
    end(payload) {
      responseData = JSON.parse(payload);
    },
  };

  const promise = router.handleSaveConfig(mockReq, mockRes);
  mockReq.emit('data', JSON.stringify({
    appId: 'cli_new_app',
    enableThinkingFold: false,
  }));
  mockReq.emit('end');
  await promise;

  assert.equal(responseData.code, 0);
  assert.equal(updatedConfig.appId, 'cli_new_app');
  assert.equal(updatedConfig.enableThinkingFold, false);
});

test('Task 8 (Settings): QR Pairing lifecycle - generate, poll, and confirm', async () => {
  let boundOwner = null;
  const router = new FeishuConfigRouter({
    config: { appId: 'cli_pair_app', ownerId: '' },
    onConfigUpdate: (cfg) => {
      boundOwner = cfg.ownerId;
    },
  });

  // 1. Generate QR code
  let genResult = null;
  const mockRes1 = {
    setHeader() {},
    writeHead() {},
    end(payload) {
      genResult = JSON.parse(payload);
    },
  };
  await router.handleGenerateQr({}, mockRes1);

  assert.equal(genResult.code, 0);
  assert.ok(genResult.token, 'Should return pairing token');
  assert.ok(genResult.svg.includes('<svg'), 'Should return QR SVG');

  const token = genResult.token;

  // 2. Poll initial pending status
  let pollResult = null;
  const mockRes2 = {
    setHeader() {},
    writeHead() {},
    end(payload) {
      pollResult = JSON.parse(payload);
    },
  };
  const pollUrl = new URL(`http://127.0.0.1/api/feishu/qr/poll?token=${token}`);
  await router.handlePollQr({}, mockRes2, pollUrl);
  assert.equal(pollResult.status, 'pending');

  // 3. User scans and confirms in Feishu
  const confirmed = router.confirmPairing(token, {
    openId: 'ou_scanned_user_888',
    userName: '飞书工程师',
  });
  assert.equal(confirmed, true);
  assert.equal(boundOwner, 'ou_scanned_user_888', 'Should auto bind scanned user as owner');

  // 4. Poll again, should show scanned
  let pollResult2 = null;
  const mockRes3 = {
    setHeader() {},
    writeHead() {},
    end(payload) {
      pollResult2 = JSON.parse(payload);
    },
  };
  await router.handlePollQr({}, mockRes3, pollUrl);
  assert.equal(pollResult2.status, 'scanned');
  assert.equal(pollResult2.openId, 'ou_scanned_user_888');
});
