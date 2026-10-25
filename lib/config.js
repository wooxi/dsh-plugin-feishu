let Schema;
try {
  const schemastery = await import('@deepseek-ai/schemastery');
  Schema = schemastery.default || schemastery.Schema;
} catch {
  const node = (base) => {
    const self = { ...base };
    self.description = (text) => {
      self._description = text;
      return self;
    };
    self.default = (value) => {
      self._default = value;
      return self;
    };
    self.role = (role) => {
      self._role = role;
      return self;
    };
    return self;
  };
  Schema = {
    object: (props) => node({ type: 'object', properties: props }),
    string: () => node({ type: 'string' }),
    boolean: () => node({ type: 'boolean' }),
    number: () => node({ type: 'number' }),
    intersect: (...schemas) => node({ type: 'intersect', schemas }),
  };
}

export const Config = Schema.object({
  appId: Schema.string().description('飞书应用 App ID (形如 cli_xxx)').default(''),
  appSecret: Schema.string().role('secret').description('飞书应用 App Secret').default(''),
  encryptKey: Schema.string().role('secret').description('飞书事件订阅 Encrypt Key (选填)').default(''),
  verificationToken: Schema.string().role('secret').description('飞书事件订阅 Verification Token (选填)').default(''),
  ownerId: Schema.string().description('专属管理员 OpenID (为空则首次绑定的用户成为管理员)').default(''),
  workspaceDir: Schema.string().description('飞书会话文件与媒体专属存储目录').default('/dsh-workspace/feishu'),
  feishuWorkspaceDir: Schema.string()
    .description('飞书专属 DSH 工作区目录（会话在侧栏归属该分组）')
    .default('/dsh-workspace/feishu'),
  enableCardKit: Schema.boolean().description('启用 CardKit 2.0 增量流式更新').default(true),
  enableThinkingFold: Schema.boolean().description('在卡片顶部折叠展示思考过程').default(true),
  enableToolTracker: Schema.boolean().description('展示实时工具调用状态与耗时').default(true),
  enableMultiModal: Schema.boolean().description('支持直接发送图片与出站图片渲染').default(true),
  enableGroupChat: Schema.boolean().description('是否允许群聊 @ 机器人使用').default(false),
  dmPolicy: Schema.string()
    .description("私聊准入策略：'owner' 仅管理员可用，'open' 任何人可用")
    .default('open'),
});
