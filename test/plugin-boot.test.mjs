import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 同 integration.test.mjs：任何 apply 都不能落在真实 profile 目录上。
process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-feishu-boot-'));
delete process.env.DSH_HOME;
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

test('Task 1: package.json and cordis metadata exist', () => {
  const pkgPath = resolve(pluginDir, 'package.json');
  assert.ok(existsSync(pkgPath), 'package.json should exist');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'dsh-plugin-feishu');

  // DSH 插件市场硬性要求：bundle 清单 + ESM + files 白名单。
  assert.equal(pkg.type, 'module', '插件必须是 ESM');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向补丁文件');
  assert.equal(pkg.dsh?.client?.platform, 'web', '本插件是 Web 界面插件');
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 白名单必须声明，否则 npm 包会漏文件');
  assert.ok(pkg.license, '必须声明 license');
  assert.ok(pkg.engines?.dsh, '必须声明 engines.dsh 版本范围');

  const patchPath = resolve(pluginDir, 'cordis.patch.yml');
  assert.ok(existsSync(patchPath), 'cordis.patch.yml should exist');

  // 服务依赖由代码里的 `export const inject` 声明（官方契约），不是 package.json。
  const injects = ['credentials', 'webServer', 'sessionController', 'workspaceController'];
  const src = readFileSync(resolve(pluginDir, 'lib/index.js'), 'utf8');
  for (const svc of injects) {
    assert.ok(src.includes(`'${svc}'`), `inject 应声明 ${svc}`);
  }
});

test('Task 1: config module exports schema and defaults', async () => {
  const { Config } = await import('../lib/config.js');
  assert.ok(Config, 'Config schema should be exported');
  assert.ok(typeof Config === 'object' || typeof Config === 'function');
});

test('Task 1: plugin entry exports apply function with service dependencies', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.name, 'dsh-plugin-feishu');

  // Verify injecting mock cordis context
  let initialized = false;
  const mockCtx = {
    inject: ['credentials', 'sessionController'],
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on(event, handler) {},
    credentials: { get: () => null },
    sessionController: { submit: () => {} },
  };

  await plugin.apply(mockCtx, {
    appId: 'cli_test_id',
    appSecret: 'test_secret',
    enableCardKit: true,
  });
});
