import * as vscode from 'vscode';
import { PromptDatabase } from './database';
import { collectFormValues } from './formPanel';
import { FormValues, FormWorkflow } from './formWorkflows';

type EmptyToolInput = Record<string, never>;

/** 保存并交接记录页面已提交的工作流参数。 */
export class WorkflowSubmissionStore {
  private readonly submissions = new Map<string, FormValues>();

  /**
   * 保存由记录页面提交、等待对应 Prompt 工具读取的参数。
   * @param toolName 工作流工具的唯一名称。
   * @param values 已提交的表单参数。
   */
  set(toolName: string, values: FormValues): void {
    this.submissions.set(toolName, { ...values });
  }

  /**
   * 读取并移除对应工作流的一次性提交参数。
   * @param toolName 工作流工具的唯一名称。
   * @returns 一次性提交参数；不存在时返回 undefined。
   */
  take(toolName: string): FormValues | undefined {
    const values = this.submissions.get(toolName);
    this.submissions.delete(toolName);
    return values;
  }

  /**
   * Prompt 无法启动时移除尚未消费的提交参数。
   * @param toolName 工作流工具的唯一名称。
   */
  clear(toolName: string): void {
    this.submissions.delete(toolName);
  }
}

export class WorkflowFormTool implements vscode.LanguageModelTool<EmptyToolInput> {
  /**
   * 创建工作流参数工具。
   * @param workflow 工具对应的提示词工作流。
   * @param database 用于保存直接从参数表单提交的数据。
   * @param submissions 用于读取记录页面已提交的数据。
   */
  constructor(
    private readonly workflow: FormWorkflow,
    private readonly database: PromptDatabase,
    private readonly submissions: WorkflowSubmissionStore
  ) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `正在打开${this.workflow.title}参数表单`,
      confirmationMessages: {
        title: `打开${this.workflow.title}参数表单`,
        message: '扩展将显示本地参数表单，并把提交内容返回给当前 Copilot 请求。'
      }
    };
  }

  /**
   * 返回记录页面已提交的参数，或在没有待处理参数时收集新参数。
   * @param _options VS Code 提供的工具调用选项。
   * @param token 当前工具调用的取消令牌。
   * @returns 包含提交参数或取消状态的工具结果。
   */
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const submittedValues = this.submissions.take(this.workflow.toolName);
    const submission = submittedValues
      ? { values: submittedValues, runPrompt: true }
      : await collectFormValues(this.workflow, token);
    const values = submission?.values;
    if (values && !submittedValues) {
      this.database.saveRecord({
        title: values.title,
        categoryId: this.workflow.toolName,
        categoryName: this.workflow.title,
        schema: this.workflow.fields,
        data: values
      });
    }

    const result = submission
      ? submission.runPrompt
        ? {
          status: 'submitted',
          workflow: this.workflow.title,
          parameters: values
        }
        : {
            status: 'saved',
            workflow: this.workflow.title,
            instruction: '用户选择仅保存参数，不运行生成。停止本次生成。'
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