import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 8 (Client UI): Feishu Settings Section registers into DSH ModuleLoader & slots', async () => {
  let loadedRegistration = null;

  globalThis.window = {
    __ModuleLoader__: {
      load: (reg) => {
        loadedRegistration = reg;
      },
    },
  };

  await import('../lib/client.js?t=' + Date.now());

  assert.ok(loadedRegistration, '__ModuleLoader__.load must be called');
  assert.equal(loadedRegistration.id, 'dsh-plugin-feishu', 'Bundle id must match dsh-plugin-feishu');
  assert.ok(typeof loadedRegistration.factory === 'function', 'Factory must be a function');

  // Materialize factory
  const mockReact = {
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    createElement: (type, props, ...children) => ({ type, props, children }),
  };

  const moduleExports = loadedRegistration.factory((name) => {
    if (name === 'react') return mockReact;
    return {};
  });

  assert.ok(typeof moduleExports.apply === 'function');
  assert.deepEqual(moduleExports.inject, ['slots']);

  let injectedSlot = null;
  let registeredDefinition = null;
  let registeredComponent = null;

  const mockCtx = {
    slots: {
      inject: (slotName, callback) => {
        injectedSlot = slotName;
        callback();
      },
      register: (def, comp) => {
        registeredDefinition = def;
        registeredComponent = comp;
      },
    },
  };

  moduleExports.apply(mockCtx);

  assert.equal(injectedSlot, 'settings.section', 'Must inject into settings.section slot');
  assert.equal(registeredDefinition.id, 'feishu');
  assert.equal(registeredDefinition.order, 60);
  assert.equal(registeredDefinition.label(), '飞书通道');
  assert.ok(registeredDefinition.icon().includes('<svg'), 'Icon should be valid SVG markup');
  assert.ok(registeredComponent, 'A valid React component should be registered');

  // Verify component creates elements
  const element = registeredComponent();
  assert.ok(element);
  assert.equal(element.type, 'div');
});
