import * as vscode from 'vscode';
import { collectFormValues } from './formPanel';
import { FormWorkflow } from './formWorkflows';

type EmptyToolInput = Record<string, never>;

export class WorkflowFormTool implements vscode.LanguageModelTool<EmptyToolInput> {
  constructor(private readonly workflow: FormWorkflow) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `正在打开${this.workflow.title}参数表单`,
      confirmationMessages: {
        title: `打开${this.workflow.title}参数表单`,
        message: '扩展将显示本地参数表单，并把提交内容返回给当前 Copilot 请求。'
      }
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const values = await collectFormValues(this.workflow, token);
    const result = values
      ? {
          status: 'submitted',
          workflow: this.workflow.title,
          parameters: values
        }
      : {
          status: 'cancelled',
          workflow: this.workflow.title,
          instruction: '用户取消了参数表单。停止本次生成，不要自行补全参数。'
        };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
    ]);
  }
}