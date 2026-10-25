/**
 * Menu & Shortcut Command Handler
 */

export class MenuHandler {
  constructor(options = {}) {
    this.onNewSession = options.onNewSession;
    this.onSwitchModel = options.onSwitchModel;
    this.onGetHelp = options.onGetHelp;
    this.onGetStatus = options.onGetStatus;
    this.logger = options.logger || console;
  }

  /**
   * Route menu action from interactive card button or Feishu custom bot menu
   * @param {object} actionPayload
   */
  async handleAction(actionPayload = {}) {
    const action = actionPayload.action || actionPayload.value?.action;
    const context = actionPayload.context || {};

    switch (action) {
      case 'menu_new_session': {
        if (this.onNewSession) {
          return await this.onNewSession(context);
        }
        return { message: '新建会话未配置处理器' };
      }

      case 'menu_switch_model': {
        const model = actionPayload.model || actionPayload.value?.model || 'deepseek-chat';
        if (this.onSwitchModel) {
          return await this.onSwitchModel(model, context);
        }
        return { message: `切换模型到 ${model}` };
      }

      case 'menu_help': {
        if (this.onGetHelp) {
          return this.onGetHelp();
        }
        return `🤖 **DeepSeek Harness 飞书通道快捷帮助**\n\n- 直接发送文本：发送提问或执行指令\n- 发送图片：触发多模态视觉理解\n- 点击卡片 [⏹ 打断执行]：立即终止当前 Agent 运行\n- 支持人机协同：收到审批/反问卡片时点选即可继续`;
      }

      case 'menu_status': {
        if (this.onGetStatus) {
          return await this.onGetStatus(context);
        }
        return { status: 'healthy', uptime: process.uptime() };
      }

      default:
        this.logger.warn?.(`[MenuHandler] Unhandled action: ${action}`);
        return { error: 'Unknown action' };
    }
  }
}
