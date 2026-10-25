// DSH Feishu Channel Client Settings Plugin
// Compliant with DSH Web Client ModuleLoader specification

(function () {
  const FEISHU_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C6.477 2 2 6.477 2 12C2 13.9 2.53 15.68 3.45 17.2L2.5 21.5L6.95 20.6C8.44 21.49 10.16 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2Z" fill="#3370FF"/>
  <path d="M7.5 13.5L10 10.5L12.5 13.5L16.5 9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

  function createFeishuSettingsView(React, opts) {
    const apiBase = (opts && opts.apiBase) || '';
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const h = React.createElement;

    return function FeishuSettingsComponent() {
      const [config, setConfig] = useState({
        appId: '',
        appSecretMasked: '',
        ownerId: '',
        workspaceDir: '/dsh-workspace/feishu-storage',
        enableCardKit: true,
        enableThinkingFold: true,
        enableToolTracker: true,
        enableMultiModal: true,
        enableGroupChat: false,
      });
      const [rawSecret, setRawSecret] = useState('');
      const [showSecret, setShowSecret] = useState(false);
      const [hasSecret, setHasSecret] = useState(false);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [testing, setTesting] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [toast, setToast] = useState(null);

      // QR pairing state
      const [qrData, setQrData] = useState(null);
      const [qrLoading, setQrLoading] = useState(false);
      const [qrStatus, setQrStatus] = useState('idle'); // 'idle' | 'pending' | 'scanned' | 'expired'
      const [scannedUser, setScannedUser] = useState(null);
      const pollTimerRef = useRef(null);

      function showToast(msg, type) {
        setToast({ msg, type: type || 'info' });
        setTimeout(() => setToast(null), 3500);
      }

      useEffect(() => {
        fetch(apiBase + '/api/feishu/config')
          .then(res => res.json())
          .then(data => {
            if (data && data.data) {
              setConfig(data.data);
              setHasSecret(data.hasSecret || false);
            }
            setLoading(false);
          })
          .catch(err => {
            console.warn('[dsh-plugin-feishu] Failed to load config:', err);
            setLoading(false);
          });

        return () => {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        };
      }, []);

      function handleGenerateQr() {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setQrLoading(true);
        setQrStatus('pending');
        setScannedUser(null);

        fetch(apiBase + '/api/feishu/qr/generate')
          .then(res => res.json())
          .then(data => {
            setQrData(data);
            setQrLoading(false);

            const token = data.token;
            pollTimerRef.current = setInterval(() => {
              fetch(apiBase + '/api/feishu/qr/poll?token=' + token)
                .then(res => res.json())
                .then(statusData => {
                  if (statusData.status === 'scanned') {
                    clearInterval(pollTimerRef.current);
                    setQrStatus('scanned');
                    setScannedUser(statusData);
                    if (statusData.openId) {
                      setConfig(prev => Object.assign({}, prev, { ownerId: statusData.openId }));
                    }
                    showToast('飞书管理员扫码配对成功！', 'success');
                  } else if (statusData.status === 'expired') {
                    clearInterval(pollTimerRef.current);
                    setQrStatus('expired');
                  }
                })
                .catch(() => {});
            }, 2000);
          })
          .catch(err => {
            setQrLoading(false);
            showToast('生成二维码失败: ' + err.message, 'error');
          });
      }

      function handleTestConnection() {
        setTesting(true);
        setTestResult(null);

        fetch(apiBase + '/api/feishu/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId: config.appId,
            appSecret: rawSecret || undefined,
          }),
        })
          .then(res => res.json())
          .then(result => {
            setTesting(false);
            setTestResult(result);
            if (result.ok) {
              showToast('飞书 OpenAPI 连接正常！', 'success');
            } else {
              showToast('连接测试失败: ' + result.message, 'error');
            }
          })
          .catch(err => {
            setTesting(false);
            setTestResult({ ok: false, message: err.message });
            showToast('请求测试接口出错', 'error');
          });
      }

      function handleSave() {
        setSaving(true);
        const payload = Object.assign({}, config);
        if (rawSecret) {
          payload.appSecret = rawSecret;
        }

        fetch(apiBase + '/api/feishu/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(res => res.json())
          .then(result => {
            setSaving(false);
            if (result.ok) {
              showToast('飞书通道配置已保存并生效！', 'success');
              if (rawSecret) {
                setHasSecret(true);
                setRawSecret('');
                setConfig(prev => Object.assign({}, prev, {
                  appSecretMasked: rawSecret.slice(0, 4) + '****' + rawSecret.slice(-4),
                }));
              }
            } else {
              showToast('保存失败: ' + result.message, 'error');
            }
          })
          .catch(err => {
            setSaving(false);
            showToast('保存出错: ' + err.message, 'error');
          });
      }

      const styles = {
        container: {
          padding: '24px 32px',
          maxWidth: '840px',
          margin: '0 auto',
          color: 'var(--dsw-alias-label-primary, #1f2329)',
          fontFamily: 'inherit',
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '24px',
          paddingBottom: '16px',
          borderBottom: '1px solid var(--dsw-alias-border-base, #e5e6eb)',
        },
        title: {
          fontSize: '20px',
          fontWeight: 600,
          margin: 0,
        },
        card: {
          background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
          border: '1px solid var(--dsw-alias-border-base, #e5e6eb)',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '20px',
        },
        sectionTitle: {
          fontSize: '15px',
          fontWeight: 600,
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        },
        formGroup: {
          marginBottom: '16px',
        },
        label: {
          display: 'block',
          fontSize: '13px',
          fontWeight: 500,
          marginBottom: '6px',
        },
        input: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          fontSize: '13px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-base, #dee0e3)',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'inherit',
          outline: 'none',
        },
        hint: {
          fontSize: '12px',
          color: 'var(--dsw-alias-label-secondary, #646a73)',
          marginTop: '4px',
          lineHeight: '18px',
        },
        button: (variant) => ({
          padding: '8px 16px',
          fontSize: '13px',
          fontWeight: 500,
          borderRadius: '6px',
          cursor: 'pointer',
          border: variant === 'primary' ? 'none' : '1px solid var(--dsw-alias-border-base, #dee0e3)',
          background: variant === 'primary' ? '#3370FF' : 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: variant === 'primary' ? '#ffffff' : 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
        }),
        toast: (type) => ({
          position: 'fixed',
          top: '20px',
          right: '24px',
          padding: '10px 18px',
          borderRadius: '6px',
          background: type === 'error' ? '#f54a45' : type === 'success' ? '#34c724' : '#3370ff',
          color: '#ffffff',
          fontSize: '13px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 10000,
        }),
        qrBox: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          background: 'var(--dsw-alias-bg-layer-1, #f5f6f7)',
          borderRadius: '8px',
          border: '1px dashed var(--dsw-alias-border-base, #dee0e3)',
          marginTop: '12px',
        },
        switchRow: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 0',
          borderBottom: '1px solid var(--dsw-alias-border-base, #f0f1f2)',
        },
      };

      if (loading) {
        return h('div', { style: styles.container }, '正在加载飞书通道配置…');
      }

      return h('div', { style: styles.container },
        toast ? h('div', { style: styles.toast(toast.type) }, toast.msg) : null,

        // Header
        h('div', { style: styles.header },
          h('div', { dangerouslySetInnerHTML: { __html: FEISHU_ICON_SVG } }),
          h('h2', { style: styles.title }, '飞书通道配置 (Feishu Channel)'),
          h('span', { style: { fontSize: '12px', color: '#3370FF', background: '#E8F3FF', padding: '2px 8px', borderRadius: '4px' } }, 'CardKit 2.0')
        ),

        // 1. 凭据配置
        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, '应用凭据 (App Credentials)'),
          h('div', { style: styles.formGroup },
            h('label', { style: styles.label }, 'App ID (cli_xxx)'),
            h('input', {
              style: styles.input,
              value: config.appId,
              placeholder: '例如: cli_a1b2c3d4e5f6',
              onChange: (e) => setConfig(Object.assign({}, config, { appId: e.target.value })),
            }),
            h('div', { style: styles.hint }, '在飞书开放平台「应用详情 > 凭据与基础信息」获取。')
          ),

          h('div', { style: styles.formGroup },
            h('label', { style: styles.label }, 'App Secret'),
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('input', {
                style: styles.input,
                type: showSecret ? 'text' : 'password',
                value: rawSecret || (hasSecret && !rawSecret ? config.appSecretMasked : ''),
                placeholder: hasSecret ? '已配置 (输入新密钥可覆盖)' : '输入飞书应用的 App Secret',
                onChange: (e) => setRawSecret(e.target.value),
              }),
              h('button', {
                style: styles.button('default'),
                onClick: () => setShowSecret(!showSecret),
              }, showSecret ? '隐藏' : '显示')
            ),
            h('div', { style: styles.hint }, '应用密钥由宿主服务端加密存储，前端仅展示脱敏掩码。')
          ),

          h('div', { style: styles.formGroup },
            h('label', { style: styles.label }, '专属管理员 Open ID (Owner ID)'),
            h('input', {
              style: styles.input,
              value: config.ownerId,
              placeholder: '例如: ou_xxxxxxxxxxxxxx (可留空，或使用下方扫码自动填入)',
              onChange: (e) => setConfig(Object.assign({}, config, { ownerId: e.target.value })),
            }),
            h('div', { style: styles.hint }, '填入管理员的飞书 open_id，保证仅专属管理员可与此 DSH 实例交互。')
          ),

          h('div', { style: styles.formGroup },
            h('label', { style: styles.label }, '飞书专属工作区目录 (Workspace)'),
            h('input', {
              style: styles.input,
              value: config.feishuWorkspaceDir || '/dsh-workspace/feishu',
              placeholder: '/dsh-workspace/feishu',
              onChange: (e) => setConfig(Object.assign({}, config, { feishuWorkspaceDir: e.target.value })),
            }),
            h('div', { style: styles.hint }, '飞书会话在 DSH 侧栏归属该工作区分组，同时作为 Agent 的工作目录（cwd）。改动后需重启 DSH 生效。')
          ),

          h('div', { style: styles.formGroup },
            h('label', { style: styles.label }, '飞书附件与日志目录 (Storage)'),
            h('input', {
              style: styles.input,
              value: config.workspaceDir || '/dsh-workspace/feishu',
              placeholder: '/dsh-workspace/feishu',
              onChange: (e) => setConfig(Object.assign({}, config, { workspaceDir: e.target.value })),
            }),
            h('div', { style: styles.hint }, '收到的图片/文件存入 attachments/，消息流水写入 logs/feishu-messages.jsonl，Agent 产物可放 artifacts/。')
          ),

          // 连接测试按钮
          h('div', { style: { marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' } },
            h('button', {
              style: styles.button('default'),
              disabled: testing || !config.appId,
              onClick: handleTestConnection,
            }, testing ? '正在测试连接…' : '测试飞书连接连通性'),
            testResult ? h('span', {
              style: {
                fontSize: '12px',
                color: testResult.ok ? '#34c724' : '#f54a45',
              }
            }, testResult.ok ? '✓ 连接成功 (Tenant Token 正常获取)' : '✗ ' + testResult.message) : null
          )
        ),

        // 2. 扫码一键配置与绑定
        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, '飞书扫码快捷配对 (QR Pairing)'),
          h('div', { style: styles.hint },
            '点击生成配对二维码。使用飞书 App 扫描二维码，或向您的飞书机器人发送配对指令，即可一键认领专属所有者并激活通道。'
          ),

          h('div', { style: styles.qrBox },
            qrStatus === 'idle' ? h('button', {
              style: styles.button('primary'),
              disabled: qrLoading,
              onClick: handleGenerateQr,
            }, qrLoading ? '正在生成…' : '生成飞书配对二维码') : null,

            qrStatus === 'pending' && qrData ? h('div', { style: { textAlign: 'center' } },
              h('div', {
                style: { width: '180px', height: '180px', margin: '0 auto', background: '#ffffff', padding: '10px', borderRadius: '8px' },
                dangerouslySetInnerHTML: { __html: qrData.svg || '' },
              }),
              h('div', { style: { marginTop: '12px', fontSize: '13px', fontWeight: 600 } }, '请使用手机飞书扫描上方二维码'),
              h('div', { style: styles.hint }, '或向机器人私聊发送：/pair ' + qrData.token),
              h('button', {
                style: Object.assign({}, styles.button('default'), { marginTop: '12px' }),
                onClick: handleGenerateQr,
              }, '重新生成二维码')
            ) : null,

            qrStatus === 'scanned' ? h('div', { style: { textAlign: 'center', color: '#34c724' } },
              h('div', { style: { fontSize: '24px', marginBottom: '8px' } }, '✓'),
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '扫码认证成功！'),
              scannedUser ? h('div', { style: styles.hint }, '已将 ' + (scannedUser.userName || '用户') + ' 绑定为管理员') : null
            ) : null,

            qrStatus === 'expired' ? h('div', { style: { textAlign: 'center', color: '#f54a45' } },
              h('div', { style: { fontSize: '14px', fontWeight: 500, marginBottom: '8px' } }, '二维码已过期'),
              h('button', {
                style: styles.button('default'),
                onClick: handleGenerateQr,
              }, '重新生成')
            ) : null
          )
        ),

        // 3. 高级交互选项开关
        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, '高级特性开关 (Features)'),
          [
            {
              key: 'enableCardKit',
              label: 'CardKit 2.0 原生卡片流式输出',
              hint: '基于飞书最新卡片规范进行打字机流式输出，彻底避免消息频繁编辑刷屏。',
            },
            {
              key: 'enableThinkingFold',
              label: '思考过程折叠 (Thinking Folds)',
              hint: '自动将 DeepSeek 等模型的长思考链折叠在卡片上方折叠块中，保持对话整洁。',
            },
            {
              key: 'enableToolTracker',
              label: '工具调用状态指示 (Tool Tracker)',
              hint: '在卡片顶部实时展示当前正在执行的工具（如 bash、grep 等）以及耗时进度。',
            },
            {
              key: 'enableMultiModal',
              label: '多模态图文输入与输出回显',
              hint: '支持在飞书聊天中发送截屏并自动投喂会话；支持输出的 Markdown 图片自动上传回显。',
            },
            {
              key: 'enableGroupChat',
              label: '群聊 @ 机器人协作支持',
              hint: '开启后支持在飞书群聊中 @ 机器人协作；关闭时仅专属管理员可私聊使用。',
            },
          ].map(item => h('div', { key: item.key, style: styles.switchRow },
            h('div', { style: { flex: 1, paddingRight: '16px' } },
              h('div', { style: { fontSize: '13px', fontWeight: '500' } }, item.label),
              h('div', { style: styles.hint }, item.hint)
            ),
            h('input', {
              type: 'checkbox',
              checked: Boolean(config[item.key]),
              style: { width: '18px', height: '18px', cursor: 'pointer' },
              onChange: (e) => setConfig(Object.assign({}, config, { [item.key]: e.target.checked })),
            })
          ))
        ),

        // 4. 保存条
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px' } },
          h('button', {
            style: styles.button('primary'),
            disabled: saving,
            onClick: handleSave,
          }, saving ? '正在保存中…' : '保存设置')
        )
      );
    };
  }

  function applyPlugin(ctx, React) {
    if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
    ctx.slots.inject('settings.section', function () {
      ctx.slots.register({
        name: 'settings.section',
        id: 'feishu',
        order: 60,
        label: function () { return '飞书通道'; },
        icon: function () { return FEISHU_ICON_SVG; },
      }, createFeishuSettingsView(React));
    });
  }

  // 1. DSH Browser ModuleLoader Registration
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-plugin-feishu',
      factory: function (require) {
        var mod = { exports: {} };
        var React = require('react');
        var inject = ['slots'];

        function apply(ctx) {
          applyPlugin(ctx, React);
        }

        mod.exports.apply = apply;
        mod.exports.inject = inject;
        mod.exports.FeishuSettingsView = function (R) { return createFeishuSettingsView(R || React); };
        return mod.exports;
      },
    });
  }

  // 2. Global export for testing / headless execution
  if (typeof globalThis !== 'undefined') {
    globalThis.__dsh_feishu_client__ = {
      apply: function (ctx) {
        var React = globalThis.React || {
          useState: function (i) { return [i, function () {}]; },
          useEffect: function () {},
          useRef: function () { return { current: null }; },
          createElement: function (type, props) { return { type: type, props: props }; },
        };
        applyPlugin(ctx, React);
      },
      inject: ['slots'],
      FeishuSettingsView: createFeishuSettingsView,
    };
  }
})();
