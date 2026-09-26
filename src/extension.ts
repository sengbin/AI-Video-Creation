/*
------------------------------------------------------------------------
名称：AI 视频创作工具扩展入口
说明：注册扩展生命周期与基础测试命令，后续在此接入创作表单工具。
作者：Lion
邮箱：chengbin@3578.cn
日期：2026-09-24
备注：
------------------------------------------------------------------------
*/

import * as vscode from 'vscode';
import { formWorkflows } from './formWorkflows';
import { WorkflowFormTool } from './workflowFormTool';

/**
 * 激活扩展并注册用于验证扩展运行状态的命令。
 * @param context VS Code 扩展上下文。
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    ...formWorkflows.map((workflow) =>
      vscode.lm.registerTool(workflow.toolName, new WorkflowFormTool(workflow))
    )
  );
}

/**
 * 释放扩展停用时需要清理的资源。
 */
export function deactivate(): void {}