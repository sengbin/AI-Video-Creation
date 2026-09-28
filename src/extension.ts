/*
------------------------------------------------------------------------
名称：AI视频创作助手扩展入口
说明：初始化用户级数据库并注册创作参数表单工具。
作者：Lion
邮箱：chengbin@3578.cn
日期：2026-09-24
备注：
------------------------------------------------------------------------
*/

import * as vscode from 'vscode';
import { PromptDatabase } from './database';
import { formWorkflows } from './formWorkflows';
import { PromptRecordsViewProvider } from './promptRecordsView';
import {
  GeneratedResultTool,
  SAVE_GENERATED_RESULT_TOOL_NAME,
  WorkflowFormTool,
  WorkflowSubmissionStore
} from './workflowFormTool';

export const PROMPT_RECORDS_VIEW_ID = 'aiVideoCreation.promptRecords';

/**
 * 激活扩展、初始化用户级数据库并注册创作参数表单工具。
 * @param context VS Code 扩展上下文。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const database = await PromptDatabase.open(context.globalStorageUri);
  database.deleteRecordsWithConflictingFields(
    formWorkflows.filter((workflow) => workflow.supportsChapterContent === true).map((workflow) => workflow.toolName),
    ['episodeDurationSeconds', 'maxEpisodes']
  );
  const submissions = new WorkflowSubmissionStore();
  const recordsView = new PromptRecordsViewProvider(
    database,
    formWorkflows,
    context.extensionUri,
    submissions
  );
  context.subscriptions.push(database);
  context.subscriptions.push(recordsView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PROMPT_RECORDS_VIEW_ID, recordsView)
  );

  context.subscriptions.push(
    ...formWorkflows.map((workflow) =>
      vscode.lm.registerTool(workflow.toolName, new WorkflowFormTool(workflow, database, submissions))
    )
  );
  context.subscriptions.push(
    vscode.lm.registerTool(SAVE_GENERATED_RESULT_TOOL_NAME, new GeneratedResultTool(database))
  );
}

