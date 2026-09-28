import * as vscode from 'vscode';
import { WorkProject, PromptDatabase, PromptRecord } from './database';
import { collectFormValues, FormSubmission } from './formPanel';
import { GeneratedEpisodeContent } from './episodeContent';
import {
  FormField,
  FormValues,
  FormWorkflow,
  getWorkflowResultType,
  RECORD_TITLE_FIELD,
  SCREENPLAY_WORKFLOW_NAME,
  SHOOTING_SCRIPT_WORKFLOW_NAME
} from './formWorkflows';
import { WorkflowSubmissionStore } from './workflowFormTool';

interface ViewMessage {
  readonly command: string;
  readonly categoryId?: string;
  readonly recordId?: string;
  readonly confirmationTitle?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectDescription?: string;
  readonly content?: string;
  readonly contentZh?: string;
  readonly contentEn?: string;
}

/** Provides an editor-area page for managing saved prompt records. */
export class PromptRecordsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private categoryView: vscode.Webview | undefined;
  private selectedCategoryId: string | undefined;
  private selectedWorkProjectFilter = 'all';
  private viewMode: 'records' | 'projects' | 'create-project' | 'edit-project' = 'records';
  private editingWorkProjectId: string | undefined;
  private categoryMessageSubscription: vscode.Disposable | undefined;
  private visibilitySubscription: vscode.Disposable | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private readonly activeRecordForms = new Set<string>();
  private readonly databaseSubscription: vscode.Disposable;

  /**
   * 创建提示词记录视图。
   * @param database 用户级记录数据库。
   * @param workflows 可用的提示词工作流。
   * @param extensionUri 扩展安装目录 URI。
   * @param submissions 供参数工具读取的一次性提交数据存储。
   */
  constructor(
    private readonly database: PromptDatabase,
    private readonly workflows: readonly FormWorkflow[],
    private readonly extensionUri: vscode.Uri,
    private readonly submissions: WorkflowSubmissionStore
  ) {
    this.databaseSubscription = database.onDidChangeRecords(() => this.postState());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.categoryView = view.webview;
    view.webview.html = createCategoryHtml();
    this.categoryMessageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleCategoryMessage(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(errorMessage(error));
      });
    });
    this.visibilitySubscription = view.onDidChangeVisibility(() => {
      this.postState();
    });
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const selectedCategoryTitle = this.viewMode === 'projects' ? '项目管理'
      : this.viewMode === 'create-project' ? '创建项目'
        : this.viewMode === 'edit-project' ? '编辑项目'
          : this.workflows.find((workflow) => workflow.toolName === this.selectedCategoryId)?.title ?? '请选择任务';
    const panel = vscode.window.createWebviewPanel(
      'aiVideoCreation.promptRecordsEditor',
      selectedCategoryTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel = panel;
    panel.webview.html = createPageHtml(this.workflows);
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handlePanelMessage(message).catch((error: unknown) => {
          void vscode.window.showErrorMessage(errorMessage(error));
        });
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
        this.disposePanelSubscriptions();
      })
    ];
  }

  dispose(): void {
    this.categoryMessageSubscription?.dispose();
    this.visibilitySubscription?.dispose();
    this.databaseSubscription.dispose();
    this.panel?.dispose();
    this.panel = undefined;
    this.categoryView = undefined;
    this.disposePanelSubscriptions();
  }

  private disposePanelSubscriptions(): void {
    for (const subscription of this.panelSubscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  private async handleCategoryMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.command !== 'string') {
      return;
    }

    const message = value as unknown as ViewMessage;
    if (message.command === 'ready') {
      this.postState();
      return;
    }

    if (message.command === 'select-category') {
      if (typeof message.categoryId !== 'string' ||
          !this.workflows.some((workflow) => workflow.toolName === message.categoryId)) {
        throw new Error('提示词分类标识无效。');
      }
      this.selectedCategoryId = message.categoryId;
      this.viewMode = 'records';
      this.open();
      this.postState();
      return;
    }

    if (message.command === 'open-projects') {
      this.viewMode = 'projects';
      this.selectedCategoryId = undefined;
      this.open();
      this.postState();
      return;
    }

    if (message.command === 'add-record') {
      await this.addRecord(message.categoryId);
      return;
    }

    if (message.command === 'create-project') {
      this.viewMode = 'create-project';
      this.selectedCategoryId = undefined;
      this.open();
      this.postState();
    }

  }

  private async handlePanelMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.command !== 'string') {
      return;
    }

    const message = value as unknown as ViewMessage;
    if (message.command === 'ready') {
      this.postState();
      return;
    }
    if (message.command === 'submit-project') {
      try {
        this.createWorkProject(message.projectName, message.projectDescription);
      } catch (error) {
        void this.panel?.webview.postMessage({ command: 'project-create-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'update-project') {
      try {
        this.updateWorkProject(message.projectId, message.projectName, message.projectDescription);
      } catch (error) {
        void this.panel?.webview.postMessage({ command: 'project-create-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'cancel-project-create') {
      this.viewMode = 'projects';
      this.editingWorkProjectId = undefined;
      this.postState();
      return;
    }
    if (message.command === 'select-record') {
      await this.editRecord(message.recordId);
      return;
    }
    if (message.command === 'run-record') {
      await this.runRecord(message.recordId);
      return;
    }
    if (message.command === 'project-filter') {
      if (typeof message.projectId !== 'string' ||
          (message.projectId !== 'all' && message.projectId !== '0' &&
           !this.database.listWorkProjects().some((project) => project.id === message.projectId))) {
        throw new Error('项目筛选条件无效。');
      }
      this.selectedWorkProjectFilter = message.projectId;
      this.postState();
      return;
    }
    if (message.command === 'edit-project') {
      await this.editWorkProject(message.projectId);
      return;
    }
    if (message.command === 'delete-project') {
      try {
        this.deleteWorkProject(message.projectId, message.confirmationTitle);
      } catch (error) {
        void this.panel?.webview.postMessage({ command: 'delete-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'view-result') {
      this.postGeneratedResult(message.recordId);
      return;
    }
    if (message.command === 'view-episodes') {
      this.postGeneratedEpisodes(message.recordId);
      return;
    }
    if (message.command === 'save-generated-result') {
      try {
        this.saveGeneratedResult(message.recordId, message.content, message.contentZh, message.contentEn);
      } catch (error) {
        void this.panel?.webview.postMessage({
          command: 'generated-result-save-error',
          recordId: message.recordId,
          text: errorMessage(error)
        });
      }
      return;
    }
    if (message.command === 'delete-record') {
      try {
        this.deleteRecord(message.recordId, message.confirmationTitle);
      } catch (error) {
        void this.panel?.webview.postMessage({
          command: 'delete-error',
          text: errorMessage(error)
        });
      }
    }
  }

  /** 核对用户输入的标题后删除记录。 */
  private deleteRecord(recordId: string | undefined, confirmationTitle: string | undefined): void {
    if (typeof recordId !== 'string' || typeof confirmationTitle !== 'string') {
      throw new Error('删除记录所需信息缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('记录不存在或已被删除。');
    }

    const expectedTitle = record.title || '旧记录（无标题）';
    if (confirmationTitle !== expectedTitle) {
      throw new Error('输入的标题与记录标题不一致，未删除。');
    }
    if (!this.database.deleteRecord(record.id)) {
      throw new Error('删除记录失败。');
    }

    void this.panel?.webview.postMessage({ command: 'delete-success' });
  }

  /** 按需向记录页面发送指定记录的 Copilot 返回内容。 */
  private postGeneratedResult(recordId: string | undefined): void {
    if (typeof recordId !== 'string') {
      throw new Error('查看生成结果所需的记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要查看的提示词记录不存在。');
    }

    const isBilingualContent = record.categoryId === SHOOTING_SCRIPT_WORKFLOW_NAME;
    const isContent = getWorkflowResultType(record.categoryId) === 'content';
    void this.panel?.webview.postMessage({
      command: 'generated-result',
      recordId: record.id,
      title: record.title || '旧记录（无标题）',
      resultType: isBilingualContent ? 'bilingual-content' : isContent ? 'content' : 'prompt',
      ...(isContent && !isBilingualContent
        ? { content: record.generatedResultContent ?? '' }
        : {
            contentZh: record.generatedResultChinese ?? '',
            contentEn: record.generatedResultEnglish ?? ''
          })
    });
  }

  /** 按需向记录页面发送指定创作任务的分集内容。 */
  private postGeneratedEpisodes(recordId: string | undefined): void {
    if (typeof recordId !== 'string') {
      throw new Error('查看分集内容所需的记录标识缺失。');
    }
    const record = this.database.getRecord(recordId);
    if (!record || !this.workflows.some((workflow) =>
      workflow.toolName === record.categoryId && workflow.supportsEpisodeContent === true
    )) {
      throw new Error('要查看的分集创作任务不存在。');
    }
    const episodes: GeneratedEpisodeContent[] = this.database.listGeneratedEpisodeContents(recordId);
    void this.panel?.webview.postMessage({
      command: 'generated-episodes',
      recordId,
      title: record.title || '旧记录（无标题）',
      episodes
    });
  }

  /** 保存用户在结果弹层中修改的作品内容或双语提示词。 */
  private saveGeneratedResult(
    recordId: string | undefined,
    content: string | undefined,
    contentZh: string | undefined,
    contentEn: string | undefined
  ): void {
    if (typeof recordId !== 'string') {
      throw new Error('保存生成结果所需的记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要修改的生成结果记录不存在。');
    }

    let updatedRecord: PromptRecord | undefined;
    if (record.categoryId === SHOOTING_SCRIPT_WORKFLOW_NAME) {
      if (content !== undefined || typeof contentZh !== 'string' || typeof contentEn !== 'string') {
        throw new Error('拍摄脚本必须保存中英文内容。');
      }
      updatedRecord = this.database.updateGeneratedResult(recordId, contentZh, contentEn);
    } else if (getWorkflowResultType(record.categoryId) === 'content') {
      if (typeof content !== 'string' || contentZh !== undefined || contentEn !== undefined) {
        throw new Error('该工作流只能保存单篇创作内容。');
      }
      updatedRecord = this.database.updateGeneratedContent(recordId, content);
    } else {
      if (typeof content !== 'undefined' || typeof contentZh !== 'string' || typeof contentEn !== 'string') {
        throw new Error('该工作流必须保存中英文提示词。');
      }
      updatedRecord = this.database.updateGeneratedResult(recordId, contentZh, contentEn);
    }

    if (!updatedRecord) {
      throw new Error('要修改的提示词记录不存在。');
    }

    void this.panel?.webview.postMessage({
      command: 'generated-result-saved',
      recordId
    });
  }

  private async addRecord(categoryId: string | undefined): Promise<void> {
    const workflow = this.findWorkflow(categoryId);
    if (this.activeRecordForms.has(workflow.toolName)) {
      return;
    }
    this.activeRecordForms.add(workflow.toolName);

    const formWorkflow: FormWorkflow = {
      ...workflow,
      title: `添加${workflow.title}信息`,
      notice: '填写信息后可保存，或保存并运行对应提示词。'
    };
    let submission: FormSubmission | undefined;
    try {
      submission = await collectViewForm(
        formWorkflow,
        undefined,
        this.database.listWorkProjects()
      );
    } finally {
      this.activeRecordForms.delete(workflow.toolName);
    }
    if (!submission) {
      return;
    }

    const record = this.database.saveRecord({
      title: submission.values.title,
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      projectId: submission.projectId,
      schema: workflow.fields,
      data: submission.values
    });
    this.selectedCategoryId = workflow.toolName;
    this.postState();
    if (submission.runPrompt) {
      await this.runSubmittedPrompt(workflow, submission.values, record.id);
    }
  }

  private async editRecord(recordId: string | undefined): Promise<void> {
    if (typeof recordId !== 'string') {
      throw new Error('记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要修改的记录不存在。');
    }

    const workflow = this.findWorkflow(record.categoryId);
    const savedFields = readFormFields(record.schema);
    const fields = savedFields.some((field) => field.name === 'title')
      ? savedFields
      : [RECORD_TITLE_FIELD, ...savedFields];
    const recordValues = readFormValues(record.data);
    const initialValues = {
      ...recordValues,
      title: record.title ?? recordValues.title ?? '',
      projectId: record.projectId
    };
    const editWorkflow: FormWorkflow = {
      ...workflow,
      title: `选择${workflow.title}信息`,
      notice: '可修改参数并保存；需要生成内容时，请在任务列表中选择“运行生成”。',
      showRunButton: false,
      fields
    };
    const submission = await collectViewForm(
      editWorkflow,
      initialValues,
      this.database.listWorkProjects()
    );
    if (!submission) {
      return;
    }

    const updatedRecord = this.database.updateRecord(record.id, {
      title: submission.values.title,
      projectId: submission.projectId,
      schema: fields,
      data: submission.values
    });
    if (!updatedRecord) {
      throw new Error('记录已不存在，无法保存修改。');
    }

    this.selectedCategoryId = record.categoryId;
    this.postState();
    if (submission.runPrompt) {
      await this.runSubmittedPrompt(workflow, submission.values, record.id);
    }
  }

  private async runRecord(recordId: string | undefined): Promise<void> {
    if (typeof recordId !== 'string') {
      throw new Error('记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要运行的记录不存在或已被删除。');
    }

    const workflow = this.findWorkflow(record.categoryId);
    await this.runSubmittedPrompt(workflow, readFormValues(record.data), record.id);
  }

  /** 将已提交参数及其记录标识交给对应的 Prompt 工具并启动提示词。 */
  private async runSubmittedPrompt(
    workflow: FormWorkflow,
    values: FormValues,
    recordId: string
  ): Promise<void> {
    const record = this.database.getRecord(recordId);
    this.submissions.set(
      workflow.toolName,
      values,
      recordId,
      record?.projectId ?? '0'
    );
    const promptUri = vscode.Uri.joinPath(this.extensionUri, workflow.promptPath);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.run.prompt.current', promptUri);
    } catch (error) {
      this.submissions.clear(workflow.toolName);
      throw error;
    }
  }

  /** 校验编辑器页面提交的数据并创建项目。 */
  private createWorkProject(name: string | undefined, description: string | undefined): void {
    if (typeof name !== 'string' || typeof description !== 'string' || !name.trim()) {
      throw new Error('项目名称不能为空，项目简介必须是文本。');
    }
    this.database.createWorkProject({ name, description });
    this.viewMode = 'projects';
    this.selectedCategoryId = undefined;
    this.postState();
  }

  /** 打开指定项目的编辑页面并传入当前数据。 */
  private editWorkProject(projectId: string | undefined): void {
    if (typeof projectId !== 'string') {
      throw new Error('项目标识缺失。');
    }
    const project = this.database.listWorkProjects().find((item) => item.id === projectId);
    if (!project) {
      throw new Error('项目不存在或已被删除。');
    }
    this.editingWorkProjectId = project.id;
    this.viewMode = 'edit-project';
    this.postState();
  }

  /** 校验编辑页面提交的数据并更新项目。 */
  private updateWorkProject(
    projectId: string | undefined,
    name: string | undefined,
    description: string | undefined
  ): void {
    if (typeof projectId !== 'string' || typeof name !== 'string' ||
        typeof description !== 'string' || !name.trim()) {
      throw new Error('项目标识无效，项目名称不能为空，描述必须是文本。');
    }
    if (!this.database.updateWorkProject(projectId, { name, description })) {
      throw new Error('项目已不存在，无法保存修改。');
    }
    this.editingWorkProjectId = undefined;
    this.viewMode = 'projects';
    this.postState();
  }

  /** 校验确认名称后删除项目及其关联记录。 */
  private deleteWorkProject(projectId: string | undefined, confirmationTitle: string | undefined): void {
    if (typeof projectId !== 'string' || typeof confirmationTitle !== 'string') {
      throw new Error('删除项目所需信息缺失。');
    }
    const project = this.database.listWorkProjects().find((item) => item.id === projectId);
    if (!project) {
      throw new Error('项目不存在或已被删除。');
    }
    if (confirmationTitle !== project.name) {
      throw new Error('输入的名称与项目名称不一致，未删除。');
    }
    if (this.selectedWorkProjectFilter === project.id) {
      this.selectedWorkProjectFilter = 'all';
    }
    if (!this.database.deleteWorkProject(project.id)) {
      throw new Error('删除项目失败。');
    }
    void this.panel?.webview.postMessage({ command: 'delete-success' });
  }

  private findWorkflow(categoryId: string | undefined): FormWorkflow {
    const workflow = this.workflows.find((item) => item.toolName === categoryId);
    if (!workflow) {
      throw new Error('提示词分类标识无效。');
    }
    return workflow;
  }

  private postState(): void {
    const categories = this.workflows.map((workflow) => ({
      id: workflow.toolName,
      title: workflow.title
    }));
    if (this.categoryView) {
      void this.categoryView.postMessage({
        command: 'categories',
        categories,
        selectedCategoryId: this.selectedCategoryId
      });
    }

    if (!this.panel) {
      return;
    }

    const selectedCategory = this.workflows.find((workflow) => workflow.toolName === this.selectedCategoryId);
    const categoryTitle = this.viewMode === 'projects' ? '项目管理'
      : this.viewMode === 'create-project' ? '创建项目'
        : this.viewMode === 'edit-project' ? '编辑项目'
          : selectedCategory?.title ?? '请选择任务';
    this.panel.title = categoryTitle;
    const projects = this.database.listWorkProjects();
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const records = (this.viewMode !== 'records' || this.selectedCategoryId === undefined
      ? []
      : this.database.listRecords(
        this.selectedCategoryId,
        this.selectedWorkProjectFilter === 'all' ? undefined : this.selectedWorkProjectFilter
      )).map((record) => ({
      id: record.id,
      title: record.title,
      projectId: record.projectId,
      projectName: projectNames.get(record.projectId),
      createdAt: record.createdAt,
      generatedAt: record.generatedAt
    }));

    void this.panel.webview.postMessage({
      command: 'state',
      viewMode: this.viewMode,
      categoryId: this.selectedCategoryId,
      categoryTitle,
      records,
      projects,
      projectFilter: this.selectedWorkProjectFilter,
      editingWorkProject: this.viewMode === 'edit-project'
        ? projects.find((project) => project.id === this.editingWorkProjectId)
        : undefined
    });
  }
}

function readFormFields(value: unknown): readonly FormField[] {
  if (!Array.isArray(value) || value.some((field) =>
    !isRecord(field) ||
    typeof field.name !== 'string' ||
    typeof field.label !== 'string' ||
    typeof field.description !== 'string'
  )) {
    throw new Error('记录中保存的字段模板无效。');
  }
  return value as readonly FormField[];
}

function readFormValues(value: unknown): FormValues {
  if (!isRecord(value) || Object.values(value).some((fieldValue) => typeof fieldValue !== 'string')) {
    throw new Error('记录中保存的表单数据无效。');
  }
  return value as FormValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectViewForm(
  workflow: FormWorkflow,
  initialValues?: FormValues,
  projects: readonly WorkProject[] = []
): Promise<FormSubmission | undefined> {
  const cancellationSource = new vscode.CancellationTokenSource();
  try {
    return await collectFormValues(workflow, cancellationSource.token, initialValues, projects);
  } finally {
    cancellationSource.dispose();
  }
}

function createCategoryHtml(): string {
  const nonce = createNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background, #FFFFFF);
      --card-background: color-mix(in srgb, var(--bg) 97%, #FFFFFF);
      --config-background: color-mix(in srgb, var(--bg) 97%, #FFFFFF);
      --divider: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      --card-shadow: none;
      --menu-hover-background: #323232;
      --add-hover-background: #3D3D3D;
      --menu-pressed-background: #2F2F2F;
      --add-pressed-background: #383838;
    }
    body.vscode-light {
      --card-background: color-mix(in srgb, var(--bg) 62%, #E2E2E2);
      --config-background: color-mix(in srgb, var(--bg) 62%, #E2E2E2);
      --divider: color-mix(in srgb, #000000 8%, transparent);
      --card-shadow: 0 1px 2px rgba(0,0,0,0.07);
      --menu-hover-background: #E6E6E6;
      --add-hover-background: #DCDCDC;
      --menu-pressed-background: #DEDEDE;
      --add-pressed-background: #D4D4D4;
    }
    body.vscode-dark {
      --card-background: color-mix(in srgb, var(--bg) 97%, #FFFFFF);
      --config-background: color-mix(in srgb, var(--bg) 97%, #FFFFFF);
      --divider: color-mix(in srgb, #FFFFFF 8%, transparent);
    }
    * { box-sizing: border-box; }
    body { min-width: 0; margin: 0; padding: 8px 0 10px 16px; color: var(--vscode-foreground); background: var(--bg); font-family: var(--vscode-font-family); }
    main { display: grid; gap: 10px; padding-right: 16px; }
    .card { width: 100%; min-width: 0; }
    .card-inner {
      min-width: 0; padding: 8px; background: var(--card-background);
      border: 0; border-radius: 6px; box-shadow: var(--card-shadow);
    }
    .config-card { background: var(--config-background); border: 0; box-shadow: none; }
    h2 {
      display: flex; align-items: center; gap: 8px;
      margin: 0 0 8px; padding: 2px 0; color: var(--vscode-foreground); font-size: 12px; font-weight: 600;
    }
    h2::before {
      width: 3px; height: 16px; flex: 0 0 auto;
      background: var(--vscode-focusBorder); border-radius: 2px; content: "";
    }
    nav { display: grid; gap: 0; }
    .category-stage + .category-stage { margin-top: 10px; }
    .stage-title {
      margin: 0 0 4px; padding: 0 0 6px 11px; border-bottom: 1px solid var(--divider);
      color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600;
    }
    .category-item {
      position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0; padding: 0 0 0 2px;
      background: transparent; border: 0; border-radius: 4px;
    }
    .category-item + .category-item { margin-top: 4px; }
    .category-item:hover { background: var(--menu-hover-background); }
    .category-item.is-pressed { background: var(--menu-pressed-background); }
    button { min-width: 0; min-height: 32px; border: 0; border-radius: 3px; color: inherit; font: inherit; cursor: pointer; }
    .select { display: block; width: 100%; max-width: 100%; padding: 4px 6px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; background: transparent; }
    .add { padding: 3px 5px; color: var(--vscode-textLink-foreground); background: transparent; }
    .add:hover { background: var(--add-hover-background); }
    .add.is-pressed { background: var(--add-pressed-background); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="card-inner">
        <h2>任务</h2>
        <nav id="category-list" aria-label="任务"></nav>
      </div>
    </section>
    <section class="card">
      <div class="card-inner config-card">
        <h2>设置</h2>
        <nav aria-label="设置">
          <div class="category-item">
            <button id="open-projects" class="select" type="button">项目管理</button>
            <button id="create-project" class="add" type="button">创建</button>
          </div>
          <div class="category-item">
            <button id="open-model-config" class="select" type="button">模型配置（预览）</button>
            <button id="add-model-config" class="add" type="button">添加</button>
          </div>
        </nav>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const categoryList = document.getElementById('category-list');
    function bindPressedState(button, item, pressRow) {
      const clearPressed = () => {
        if (pressRow) item.classList.remove('is-pressed');
        button.classList.remove('is-pressed');
      };
      button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (pressRow) item.classList.add('is-pressed');
        button.classList.add('is-pressed');
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointerup', clearPressed);
      button.addEventListener('pointercancel', clearPressed);
      button.addEventListener('lostpointercapture', clearPressed);
    }
    const settingsItem = document.querySelector('.config-card .category-item');
    const openProjectsButton = document.getElementById('open-projects');
    const createProjectButton = document.getElementById('create-project');
    const modelConfigItem = document.querySelectorAll('.config-card .category-item')[1];
    const openModelConfigButton = document.getElementById('open-model-config');
    const addModelConfigButton = document.getElementById('add-model-config');
    if (!(settingsItem instanceof HTMLElement) ||
        !(openProjectsButton instanceof HTMLButtonElement) ||
        !(createProjectButton instanceof HTMLButtonElement) ||
        !(modelConfigItem instanceof HTMLElement) ||
        !(openModelConfigButton instanceof HTMLButtonElement) ||
        !(addModelConfigButton instanceof HTMLButtonElement)) {
      throw new Error('设置菜单项缺失。');
    }
    bindPressedState(openProjectsButton, settingsItem, true);
    bindPressedState(createProjectButton, settingsItem, false);
    bindPressedState(openModelConfigButton, modelConfigItem, true);
    bindPressedState(addModelConfigButton, modelConfigItem, false);
    document.getElementById('open-projects').addEventListener('click', () => {
      vscode.postMessage({ command: 'open-projects' });
    });
    document.getElementById('create-project').addEventListener('click', () => {
      vscode.postMessage({ command: 'create-project' });
    });
    const categoryStages = [
      {
        title: '阶段一 · 内容创作',
        categoryIds: [
          'ai-video-creation-tools_collect_creative_writing_parameters',
          'ai-video-creation-tools_collect_image_inspired_writing_parameters',
          'ai-video-creation-tools_collect_novel_parameters'
        ]
      },
      {
        title: '阶段二 · 视觉资产创作',
        categoryIds: [
          'ai-video-creation-tools_collect_character_parameters',
          'ai-video-creation-tools_collect_scene_parameters',
          'ai-video-creation-tools_collect_prop_parameters',
          'ai-video-creation-tools_collect_effect_parameters'
        ]
      },
      {
        title: '阶段三 · 剧本与拍摄',
        categoryIds: [
          'ai-video-creation-tools_collect_screenplay_parameters',
          'ai-video-creation-tools_collect_shooting_script_parameters'
        ]
      }
    ];

    function makeButton(text, className, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
      return button;
    }

    function renderCategories(state) {
      categoryList.replaceChildren();
      for (const stage of categoryStages) {
        const section = document.createElement('section');
        section.className = 'category-stage';
        const heading = document.createElement('h3');
        heading.className = 'stage-title';
        heading.textContent = stage.title;
        section.append(heading);

        for (const categoryId of stage.categoryIds) {
          const category = state.categories.find((item) => item.id === categoryId);
          if (!category) {
            throw new Error('创作阶段分类缺失：' + categoryId);
          }

          const item = document.createElement('div');
          item.className = 'category-item';
          const select = makeButton(category.title, 'select', category.title, () => {
            vscode.postMessage({ command: 'select-category', categoryId: category.id });
          });
          bindPressedState(select, item, true);
          const add = makeButton('添加', 'add', '添加' + category.title + '记录', () => {
            vscode.postMessage({ command: 'add-record', categoryId: category.id });
          });
          bindPressedState(add, item, false);
          item.append(select, add);
          section.append(item);
        }

        categoryList.append(section);
      }
    }

    window.addEventListener('message', (event) => {
      if (event.data.command === 'categories') renderCategories(event.data);
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function createPageHtml(workflows: readonly FormWorkflow[]): string {
  const nonce = createNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; }
    main { min-height: 100vh; padding: 24px 28px; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .edit-button { min-height: 30px; border: 0; border-radius: 3px; }
    .edit-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    section { min-width: 0; }
    .table { min-width: 0; }
    .records-table-scroll { max-width: 100%; min-width: 0; overflow-x: auto; }
    #records-table { display: table; width: max-content; min-width: 100%; border-collapse: collapse; table-layout: auto; }
    #records-table .table-header { display: table-row; padding: 0; border: 0; }
    #records-table .table-header > span { display: table-cell; padding: 10px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
    #records-table #record-list { display: table-row-group; }
    #records-table .record-row { display: table-row; min-height: 0; padding: 0; border: 0; }
    #records-table .record-row > * { display: table-cell; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); vertical-align: middle; }
    .table-header, .record-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) 96px; align-items: center; gap: 12px; }
    .table.has-project-columns .table-header, .table.has-project-columns .record-row { grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) minmax(112px, 1fr) 96px; }
    .table.has-episode-content-columns .table-header, .table.has-episode-content-columns .record-row { grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) minmax(112px, 1fr) 112px 60px; }
    #records-table:not(.has-project-columns) .project-column { display: none; }
    #records-table:not(.has-episode-content-columns) .episode-content-action-column,
    #records-table.has-episode-content-columns .row-action-column { display: none; }
    #records-table.has-episode-content-columns .episode-content-action-column { text-align: center; }
    #records-table.has-episode-content-columns .episode-content-action-column > .record-actions { justify-content: center; }
    .table-header { padding: 10px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
    .record-row { min-height: 44px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    .record-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .record-title { font-weight: 500; }
    .record-title-button {
      display: block; width: 100%; padding: 5px 0; overflow: hidden; text-align: left; text-overflow: ellipsis;
      white-space: nowrap; border: 0; color: var(--vscode-textLink-foreground); background: transparent; font: inherit; cursor: pointer;
    }
    .record-title-button:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
    .record-title-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #records-table .record-title-button { padding: 0; }
    .record-time { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .edit-button { min-width: 44px; padding: 5px 8px; color: var(--vscode-textLink-foreground); background: transparent; }
    .record-actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .record-actions button { flex: 0 0 auto; white-space: nowrap; }
    .filter-toolbar { display: flex; max-width: 720px; align-items: center; gap: 8px; margin-bottom: 14px; }
    .project-filter { position: relative; width: min(420px, 100%); min-width: 0; }
    .project-filter-trigger {
      display: flex; width: 100%; min-height: 32px; align-items: center; justify-content: space-between;
      gap: 12px; padding: 4px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; text-align: left;
    }
    .project-filter-trigger.is-scope-filter { color: var(--vscode-textLink-foreground); }
    .project-filter-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .project-filter-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-filter-chevron {
      width: 8px; height: 8px; flex: 0 0 auto; margin: -4px 2px 0 0;
      border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg);
    }
    .project-filter-menu {
      position: absolute; z-index: 5; top: calc(100% + 2px); right: 0; left: 0;
      max-height: 240px; overflow-y: auto; padding: 3px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 3px; box-shadow: 0 3px 8px var(--vscode-widget-shadow);
    }
    .project-filter-menu[hidden] { display: none; }
    .project-filter-option {
      display: block; width: 100%; min-height: 32px; padding: 5px 9px; overflow: hidden;
      color: var(--vscode-input-foreground); background: transparent; border: 0;
      text-align: left; text-overflow: ellipsis; white-space: nowrap;
    }
    .project-filter-option.is-scope-option { color: var(--vscode-textLink-foreground); }
    .project-filter-option:hover,
    .project-filter-option:focus-visible {
      background: var(--vscode-list-hoverBackground);
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 90%, #FFFFFF);
      outline: none;
    }
    .project-filter-option[aria-selected="true"] {
      color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-input-foreground));
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .project-filter-option.is-scope-option[aria-selected="true"] { color: var(--vscode-textLink-foreground); }
    .filter-button { min-height: 30px; padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; }
    .project-table .table-header, .project-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(130px, .8fr) 96px; }
    .project-description { color: var(--vscode-descriptionForeground); }
    .project-form { display: grid; max-width: 760px; gap: 16px; }
    .project-form h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .project-form label { display: block; margin-bottom: 6px; font-weight: 600; }
    .project-form input, .project-form textarea {
      width: 100%; padding: 8px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit;
    }
    .project-form input { min-height: 36px; }
    .project-form textarea { min-height: 120px; resize: vertical; }
    .project-form input:focus, .project-form textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .project-form-error { min-height: 18px; margin: 0; color: var(--vscode-errorForeground); }
    .project-form-actions { display: flex; justify-content: flex-start; gap: 8px; }
    .delete-button {
      min-width: 44px; padding: 5px 8px; border: 0; border-radius: 3px;
      color: var(--vscode-errorForeground); background: transparent;
    }
    .delete-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .delete-button:focus-visible { outline: none; background: var(--vscode-toolbar-hoverBackground); }
    .empty { padding: 24px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    dialog {
      position: fixed; inset: 50% auto auto 50%; display: flex; width: min(480px, calc(100vw - 32px)); max-width: calc(100vw - 32px);
      max-height: calc(100vh - 40px); flex-direction: column; overflow: hidden; padding: 0;
      margin: 0; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      transform: translate(-50%, -50%);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px;
    }
    dialog:not([open]) { display: none; }
    dialog[open] { display: flex; }
    dialog::backdrop { background: var(--vscode-widget-shadow); opacity: .55; }
    dialog form { min-height: 0; margin: 0; }
    .dialog-header {
      display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 12px;
      padding: 3px 6px 3px 14px; color: #F3F3F3; background: #292929; cursor: move; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,.14);
    }
    .dialog-header h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; color: inherit; font-size: 13px; font-weight: 600; }
    .dialog-close {
      display: grid; width: 26px; height: 26px; flex: 0 0 auto; place-items: center; padding: 0;
      color: #F3F3F3; background: transparent; border: 0; border-radius: 3px; font-size: 20px; line-height: 1; cursor: pointer;
    }
    .dialog-close:hover { background: #C42B1C; }
    .dialog-close:active { background: #A32319; }
    .dialog-close:focus-visible { outline: 1px solid #FFFFFF; outline-offset: -2px; }
    dialog > form { display: flex; min-height: 0; flex-direction: column; }
    .dialog-body { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 16px; }
    dialog p { margin: 0 0 14px; line-height: 1.5; overflow-wrap: anywhere; }
    .delete-title-highlight { padding: 2px 5px; color: var(--vscode-foreground); background: var(--vscode-editor-background); border-radius: 3px; }
    .delete-warning { color: var(--vscode-errorForeground); font-weight: 700; }
    dialog label { display: block; margin-bottom: 6px; }
    dialog input {
      width: 100%; min-height: 34px; padding: 6px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font: inherit;
    }
    dialog input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .delete-error { margin-top: 8px; color: var(--vscode-errorForeground); }
    .delete-error[hidden] { display: none; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    #confirm-delete:disabled { cursor: default; }
    .result-dialog { width: min(680px, calc(100vw - 32px)); }
    #episode-content-dialog { width: min(580px, calc(100vw - 32px)); }
    .result-error { margin: 8px 0 0; color: var(--vscode-errorForeground); }
    .result-error[hidden] { display: none; }
    .result-field { display: grid; gap: 6px; margin-top: 12px; }
    .result-field[hidden], #prompt-result-fields[hidden] { display: none; }
    .result-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .result-field-heading label { margin: 0; }
    .result-copy-button {
      min-height: 28px; padding: 4px 8px; border: 0; border-radius: 3px;
      color: var(--vscode-textLink-foreground); background: transparent; transition: opacity .3s ease;
    }
    .result-copy-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .result-copy-button.is-fading { opacity: 0; }
    .result-dialog textarea {
      display: block; width: 100%; max-height: calc(18em + 18px); padding: 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px;
      font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5;
      resize: none; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .result-dialog textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .episode-content-table { max-height: min(60vh, 480px); overflow-y: auto; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; }
    .episode-content-header, .episode-content-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: start; gap: 10px; padding: 8px 10px; }
    .episode-content-header { color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
    .episode-content-row + .episode-content-row { border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    .episode-content-cell { min-width: 0; overflow-wrap: anywhere; }
    .episode-content-detail { min-width: 0; }
    .episode-content-title { display: block; margin: 0 0 6px; overflow-wrap: anywhere; font-weight: 600; }
    .episode-content-text { margin: 0; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .episode-content-empty { margin: 0; padding: 20px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    .episode-content-empty[hidden] { display: none; }
    .dialog-resize-handle { position: absolute; z-index: 2; touch-action: none; user-select: none; }
    [data-resizable="false"] .dialog-resize-handle { display: none; }
    .dialog-resize-horizontal { top: 36px; right: 0; bottom: 10px; width: 7px; cursor: ew-resize; }
    .dialog-resize-vertical { right: 10px; bottom: 0; left: 10px; height: 7px; cursor: ns-resize; }
    .dialog-resize-corner { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; }
    .dialog-resize-corner::after {
      position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 1px solid var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-descriptionForeground);
      content: "";
    }
    @media (max-width: 720px) {
      main { padding: 16px 12px; }
      .table-header, .record-row { grid-template-columns: minmax(0, 1fr) 86px 96px; gap: 5px; }
      .table.has-project-columns .table-header, .table.has-project-columns .record-row { grid-template-columns: minmax(0, 1fr) minmax(72px, .9fr) 76px 96px; gap: 5px; }
      .table.has-episode-content-columns .table-header, .table.has-episode-content-columns .record-row { grid-template-columns: minmax(0, 1fr) minmax(72px, .9fr) 76px 92px 52px; gap: 5px; }
      .project-table .table-header, .project-row { grid-template-columns: minmax(0, 1fr) minmax(90px, 1.1fr) 86px 96px; gap: 5px; }
      .record-time { font-size: 10px; }
    }
  </style>
</head>
<body>
  <main>
    <section id="records-section" aria-live="polite">
      <div class="filter-toolbar">
        <div class="project-filter" id="project-filter">
          <button id="project-filter-trigger" class="project-filter-trigger is-scope-filter" type="button"
            role="combobox" aria-label="按项目筛选" aria-haspopup="listbox" aria-expanded="false" aria-controls="project-filter-menu">
            <span id="project-filter-label" class="project-filter-label">所有内容</span>
            <span class="project-filter-chevron" aria-hidden="true"></span>
          </button>
          <div id="project-filter-menu" class="project-filter-menu" role="listbox" aria-label="项目筛选选项" hidden></div>
        </div>
      </div>
      <div class="records-table-scroll">
        <div id="records-table" class="table" role="table">
          <div class="table-header" role="row"><span>查看生成内容</span><span class="project-column">项目名称</span><span>添加时间</span><span class="generated-time-column">生成时间</span><span class="episode-content-action-column">操作</span><span class="row-action-column"></span></div>
          <div id="record-list" role="rowgroup"></div>
        </div>
      </div>
    </section>
    <section id="projects-section" class="project-table" aria-live="polite" hidden>
      <div class="table-header" role="row"><span>项目名称</span><span>项目简介</span><span>创建时间</span><span></span></div>
      <div id="project-list" role="rowgroup"></div>
    </section>
    <section id="create-project-section" hidden>
      <form id="project-form" class="project-form">
        <h2 id="project-form-title">创建项目</h2>
        <div>
          <label for="project-name">项目名称</label>
          <input id="project-name" name="name" type="text" maxlength="120" required autocomplete="off">
        </div>
        <div>
          <label for="project-description">项目简介</label>
          <textarea id="project-description" name="description" rows="5"></textarea>
        </div>
        <p id="project-form-error" class="project-form-error" role="alert"></p>
        <div class="project-form-actions">
          <button id="cancel-project-create" class="edit-button" type="button">取消</button>
          <button id="save-project" class="filter-button" type="submit">创建</button>
        </div>
      </form>
    </section>
    <dialog id="project-warning-dialog" data-resizable="false" aria-labelledby="project-warning-title">
      <div class="dialog-header">
        <h2 id="project-warning-title">删除项目</h2>
        <button class="dialog-close" id="close-project-warning" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="dialog-body">
        <p class="delete-warning">此操作不可撤销。删除项目会同时删除该项目下的所有任务数据及已生成内容。</p>
        <p id="project-warning-name"></p>
        <div class="dialog-actions">
          <button id="cancel-project-warning" type="button">取消</button>
          <button id="continue-project-delete" class="delete-button" type="button">继续删除</button>
        </div>
      </div>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
    <dialog id="delete-dialog" data-resizable="false" aria-labelledby="delete-dialog-title">
      <form id="delete-form">
        <div class="dialog-header">
          <h2 id="delete-dialog-title">确认删除记录</h2>
          <button class="dialog-close" id="close-delete" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="dialog-body">
          <p id="delete-prompt"></p>
          <label for="delete-title">确认标题</label>
          <input id="delete-title" type="text" autocomplete="off" spellcheck="false">
          <p id="delete-error" class="delete-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="cancel-delete" type="button">取消</button>
            <button id="confirm-delete" type="submit" disabled>删除</button>
          </div>
        </div>
      </form>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
    <dialog id="episode-content-dialog" class="result-dialog" data-resizable="true" aria-labelledby="episode-content-dialog-title">
      <div class="dialog-header">
        <h2 id="episode-content-dialog-title">查看内容</h2>
        <button class="dialog-close" id="close-episode-content" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="dialog-body">
        <div class="episode-content-table" role="table" aria-label="分集内容列表">
          <div class="episode-content-header" role="row"><span role="columnheader">集数</span><span role="columnheader">分集内容</span></div>
          <div id="episode-content-list" role="rowgroup"></div>
        </div>
        <p id="episode-content-empty" class="episode-content-empty" role="status" hidden>暂无已保存的分集内容</p>
      </div>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
    <dialog id="result-dialog" class="result-dialog" data-resizable="true" aria-labelledby="result-dialog-title">
      <div class="dialog-header">
        <h2 id="result-dialog-title">查看结果</h2>
        <button class="dialog-close" id="close-result" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="dialog-body">
        <div id="content-result-field" class="result-field" hidden>
          <div class="result-field-heading">
            <label id="generated-content-label" for="generated-content">Copilot 生成的内容：</label>
            <button id="copy-content" class="result-copy-button" type="button" disabled>复制内容</button>
          </div>
          <textarea id="generated-content" aria-label="Copilot 生成的内容：" rows="1" placeholder="暂无已保存的 Copilot 生成的内容"></textarea>
        </div>
        <div id="prompt-result-fields" hidden>
          <div class="result-field">
            <div class="result-field-heading">
              <label id="generated-result-zh-label" for="generated-result-zh">Copilot 生成的中文提示词</label>
              <button id="copy-result-zh" class="result-copy-button" type="button" disabled>复制提示词</button>
            </div>
            <textarea id="generated-result-zh" aria-label="Copilot 生成的中文提示词" rows="1" placeholder="暂无已保存的 Copilot 生成的中文提示词"></textarea>
          </div>
          <div class="result-field">
            <div class="result-field-heading">
              <label id="generated-result-en-label" for="generated-result-en">Copilot 生成的英文提示词</label>
              <button id="copy-result-en" class="result-copy-button" type="button" disabled>复制提示词</button>
            </div>
            <textarea id="generated-result-en" aria-label="Copilot 生成的英文提示词" rows="1" placeholder="暂无已保存的 Copilot 生成的英文提示词"></textarea>
          </div>
        </div>
        <p id="result-error" class="result-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button id="edit-result" type="button" disabled>保存</button>
        </div>
      </div>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const contentWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.resultType === 'content')
      .map((workflow) => workflow.toolName))};
    const bilingualContentWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME)
      .map((workflow) => workflow.toolName))};
    const episodeContentWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.supportsEpisodeContent === true)
      .map((workflow) => workflow.toolName))};
    const screenplayWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.toolName === SCREENPLAY_WORKFLOW_NAME)
      .map((workflow) => workflow.toolName))};
    const workflowTitles = ${JSON.stringify(Object.fromEntries(workflows.map((workflow) => [workflow.toolName, workflow.title])))};
    const recordList = document.getElementById('record-list');
    const recordsTable = document.getElementById('records-table');
    const projectList = document.getElementById('project-list');
    const recordsSection = document.getElementById('records-section');
    const projectsSection = document.getElementById('projects-section');
    const createWorkProjectSection = document.getElementById('create-project-section');
    const projectForm = document.getElementById('project-form');
    const projectNameInput = document.getElementById('project-name');
    const projectDescriptionInput = document.getElementById('project-description');
    const projectFormError = document.getElementById('project-form-error');
    const projectFilter = document.getElementById('project-filter');
    const projectFilterTrigger = document.getElementById('project-filter-trigger');
    const projectFilterLabel = document.getElementById('project-filter-label');
    const projectFilterMenu = document.getElementById('project-filter-menu');
    const deleteDialog = document.getElementById('delete-dialog');
    const projectWarningDialog = document.getElementById('project-warning-dialog');
    const projectWarningName = document.getElementById('project-warning-name');
    const deleteForm = document.getElementById('delete-form');
    const deletePrompt = document.getElementById('delete-prompt');
    const deleteTitle = document.getElementById('delete-title');
    const deleteError = document.getElementById('delete-error');
    const confirmDelete = document.getElementById('confirm-delete');
    const resultDialog = document.getElementById('result-dialog');
    const episodeContentDialog = document.getElementById('episode-content-dialog');
    const episodeContentDialogTitle = document.getElementById('episode-content-dialog-title');
    const episodeContentList = document.getElementById('episode-content-list');
    const episodeContentEmpty = document.getElementById('episode-content-empty');
    const resultDialogTitle = document.getElementById('result-dialog-title');
    const contentResultField = document.getElementById('content-result-field');
    const promptResultFields = document.getElementById('prompt-result-fields');
    const generatedContent = document.getElementById('generated-content');
    const generatedContentLabel = document.getElementById('generated-content-label');
    const generatedResultZh = document.getElementById('generated-result-zh');
    const generatedResultEn = document.getElementById('generated-result-en');
    const generatedResultZhLabel = document.getElementById('generated-result-zh-label');
    const generatedResultEnLabel = document.getElementById('generated-result-en-label');
    const copyContentButton = document.getElementById('copy-content');
    const copyResultZhButton = document.getElementById('copy-result-zh');
    const copyResultEnButton = document.getElementById('copy-result-en');
    const resultError = document.getElementById('result-error');
    const editResultButton = document.getElementById('edit-result');
    const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    let pendingDelete;
    let viewingResultRecordId;
    let viewingEpisodeRecordId;
    let selectedCategoryId;
    let selectedProjectFilter = 'all';
    let projectFilterItems = [];
    let currentViewMode = 'records';
    let editingWorkProjectId;
    let projects = [];
    let viewingResultType;
    let isResultLoaded = false;
    const copyFeedbackTimers = new WeakMap();

    document.querySelectorAll('dialog').forEach((dialog) => {
      setupDialogInteractions(dialog, dialog.dataset.resizable === 'true');
    });

    function setupDialogInteractions(dialog, resizable) {
      const titlebar = dialog.querySelector('.dialog-header');
      titlebar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        event.preventDefault();
        const startRect = dialog.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const pointerId = event.pointerId;
        dialog.style.inset = 'auto';
        dialog.style.left = startRect.left + 'px';
        dialog.style.top = startRect.top + 'px';
        dialog.style.transform = 'none';

        const move = (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          const left = startRect.left + moveEvent.clientX - startX;
          const top = startRect.top + moveEvent.clientY - startY;
          dialog.style.left = Math.max(8, Math.min(window.innerWidth - startRect.width - 8, left)) + 'px';
          dialog.style.top = Math.max(8, Math.min(window.innerHeight - startRect.height - 8, top)) + 'px';
        };
        const finishMove = (endEvent) => {
          if (endEvent.pointerId !== pointerId) return;
          titlebar.removeEventListener('pointermove', move);
          titlebar.removeEventListener('pointerup', finishMove);
          titlebar.removeEventListener('pointercancel', finishMove);
          titlebar.removeEventListener('lostpointercapture', finishMove);
          if (titlebar.hasPointerCapture(pointerId)) titlebar.releasePointerCapture(pointerId);
        };

        titlebar.setPointerCapture(pointerId);
        titlebar.addEventListener('pointermove', move);
        titlebar.addEventListener('pointerup', finishMove);
        titlebar.addEventListener('pointercancel', finishMove);
        titlebar.addEventListener('lostpointercapture', finishMove);
      });

      if (!resizable) return;

      dialog.querySelectorAll('[data-resize]').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          const startRect = dialog.getBoundingClientRect();
          const startX = event.clientX;
          const startY = event.clientY;
          const axis = handle.dataset.resize;
          const pointerId = event.pointerId;
          dialog.style.inset = 'auto';
          dialog.style.left = startRect.left + 'px';
          dialog.style.top = startRect.top + 'px';
          dialog.style.transform = 'none';

          const resize = (moveEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            if (axis === 'horizontal' || axis === 'both') {
              dialog.style.width = Math.max(320, Math.min(window.innerWidth - 32, startRect.width + moveEvent.clientX - startX)) + 'px';
            }
            if (axis === 'vertical' || axis === 'both') {
              dialog.style.height = Math.max(180, Math.min(window.innerHeight - 40, startRect.height + moveEvent.clientY - startY)) + 'px';
            }
          };
          const finishResize = (endEvent) => {
            if (endEvent.pointerId !== pointerId) return;
            handle.removeEventListener('pointermove', resize);
            handle.removeEventListener('pointerup', finishResize);
            handle.removeEventListener('pointercancel', finishResize);
            handle.removeEventListener('lostpointercapture', finishResize);
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          };

          handle.setPointerCapture(pointerId);
          handle.addEventListener('pointermove', resize);
          handle.addEventListener('pointerup', finishResize);
          handle.addEventListener('pointercancel', finishResize);
          handle.addEventListener('lostpointercapture', finishResize);
        });
      });
    }

    function makeButton(text, className, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
      return button;
    }

    function getResultActionLabel(workflowId) {
      if (screenplayWorkflowIds.includes(workflowId)) return '查看剧本';
      if (bilingualContentWorkflowIds.includes(workflowId)) return '查看拍摄脚本';
      if (episodeContentWorkflowIds.includes(workflowId) || contentWorkflowIds.includes(workflowId)) return '查看内容';
      return '查看' + workflowTitles[workflowId] + '提示词';
    }

    function makeTime(value) {
      const time = document.createElement('span');
      time.className = 'record-cell record-time';
      time.textContent = dateFormatter.format(new Date(value));
      time.title = new Date(value).toLocaleString();
      return time;
    }

    function makeGeneratedTime(value) {
      const time = document.createElement('span');
      time.className = 'record-cell record-time generated-time-column';
      if (!value) {
        time.textContent = '-';
        return time;
      }
      time.textContent = dateFormatter.format(new Date(value));
      time.title = new Date(value).toLocaleString();
      return time;
    }

    function renderProjectFilter(items, selectedValue) {
      projectFilterItems = items;
      selectedProjectFilter = selectedValue;
      const selectedItem = items.find((item) => item.value === selectedValue);
      projectFilterLabel.textContent = selectedItem?.label ?? '所有内容';
      projectFilterTrigger.classList.toggle(
        'is-scope-filter',
        selectedItem?.isScopeOption === true
      );
      projectFilterMenu.replaceChildren();
      for (const item of items) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'project-filter-option';
        if (item.isScopeOption) option.classList.add('is-scope-option');
        option.setAttribute('role', 'option');
        const isSelected = item.value === selectedValue;
        option.setAttribute('aria-selected', String(isSelected));
        option.textContent = item.label;
        option.addEventListener('click', () => {
          selectedProjectFilter = item.value;
          projectFilterLabel.textContent = item.label;
          projectFilterTrigger.classList.toggle('is-scope-filter', item.isScopeOption === true);
          projectFilterMenu.querySelectorAll('[role="option"]').forEach((element) => {
            const isSelected = element === option;
            element.setAttribute('aria-selected', String(isSelected));
          });
          closeProjectFilterMenu();
          vscode.postMessage({ command: 'project-filter', projectId: item.value });
        });
        projectFilterMenu.append(option);
      }
    }

    function openProjectFilterMenu(focusIndex) {
      projectFilterMenu.hidden = false;
      projectFilterTrigger.setAttribute('aria-expanded', 'true');
      const options = projectFilterMenu.querySelectorAll('[role="option"]');
      const selectedIndex = projectFilterItems.findIndex((item) => item.value === selectedProjectFilter);
      options[Math.max(0, Math.min(focusIndex ?? selectedIndex, options.length - 1))]?.focus();
    }

    function closeProjectFilterMenu(returnFocus = false) {
      projectFilterMenu.hidden = true;
      projectFilterTrigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) projectFilterTrigger.focus();
    }

    function openDeleteDialog(record) {
      const title = record.title || '旧记录（无标题）';
      pendingDelete = { kind: 'record', id: record.id, title };
      showDeleteNameDialog('记录', title);
    }

    function openWorkProjectDeleteWarning(project) {
      pendingDelete = { kind: 'project', id: project.id, title: project.name };
      projectWarningName.textContent = '即将删除项目“' + project.name + '”及其全部绑定数据。';
      projectWarningDialog.showModal();
    }

    function showDeleteNameDialog(kind, title) {
      document.getElementById('delete-dialog-title').textContent = '确认删除' + kind;
      document.querySelector('label[for="delete-title"]').textContent = '确认' + kind + '名称';
      const highlightedTitle = document.createElement('span');
      highlightedTitle.className = 'delete-title-highlight';
      highlightedTitle.textContent = title;
      deletePrompt.replaceChildren(
        document.createTextNode('请在下方输入' + kind + '名称“'),
        highlightedTitle,
        document.createTextNode('”以确认删除。')
      );
      deleteTitle.value = '';
      deleteError.hidden = true;
      deleteError.textContent = '';
      confirmDelete.disabled = true;
      deleteDialog.showModal();
      deleteTitle.focus();
    }

    function closeDeleteDialog() {
      deleteDialog.close();
      pendingDelete = undefined;
      deleteTitle.value = '';
      deleteError.hidden = true;
      confirmDelete.disabled = true;
    }

    function openResultDialog(record) {
      const title = record.title || '旧记录（无标题）';
      const isBilingualContent = bilingualContentWorkflowIds.includes(selectedCategoryId);
      viewingResultType = isBilingualContent
        ? 'bilingual-content'
        : contentWorkflowIds.includes(selectedCategoryId) ? 'content' : 'prompt';
      const isContent = viewingResultType !== 'prompt';
      resultDialogTitle.textContent = getResultActionLabel(selectedCategoryId) + '：' + title;
      contentResultField.hidden = !isContent || isBilingualContent;
      promptResultFields.hidden = isContent && !isBilingualContent;
      configureResultLabels(selectedCategoryId, true);
      generatedContent.value = '';
      generatedResultZh.value = '';
      generatedResultEn.value = '';
      resultError.textContent = '';
      resultError.hidden = true;
      isResultLoaded = false;
      editResultButton.disabled = true;
      copyContentButton.disabled = true;
      copyResultZhButton.disabled = true;
      copyResultEnButton.disabled = true;
      viewingResultRecordId = record.id;
      resultDialog.showModal();
      resizeResultTextareas();
      (isContent && !isBilingualContent ? generatedContent : generatedResultZh).focus();
      vscode.postMessage({ command: 'view-result', recordId: record.id });
    }

    function openEpisodeContentDialog(record) {
      viewingEpisodeRecordId = record.id;
      episodeContentDialogTitle.textContent = '查看内容：' + (record.title || '旧记录（无标题）');
      episodeContentList.replaceChildren();
      episodeContentEmpty.hidden = true;
      episodeContentDialog.showModal();
      document.getElementById('close-episode-content').focus();
      vscode.postMessage({ command: 'view-episodes', recordId: record.id });
    }

    function closeEpisodeContentDialog() {
      episodeContentDialog.close();
      viewingEpisodeRecordId = undefined;
    }

    function renderEpisodeContents(episodes) {
      episodeContentList.replaceChildren();
      episodeContentEmpty.hidden = episodes.length > 0;
      for (const episode of episodes) {
        const row = document.createElement('div');
        row.className = 'episode-content-row';
        row.setAttribute('role', 'row');
        const number = document.createElement('span');
        number.className = 'episode-content-cell';
        number.setAttribute('role', 'cell');
        number.textContent = '第 ' + episode.episodeNumber + ' 集';
        const detail = document.createElement('div');
        detail.className = 'episode-content-detail';
        detail.setAttribute('role', 'cell');
        const title = document.createElement('strong');
        title.className = 'episode-content-title';
        title.textContent = episode.title;
        const content = document.createElement('p');
        content.className = 'episode-content-text';
        content.textContent = episode.content;
        detail.append(title, content);
        row.append(number, detail);
        episodeContentList.append(row);
      }
    }

    // 按工作流更新结果字段名称、辅助标签和读取状态。
    function configureResultLabels(workflowId, isLoading) {
      const isShootingScript = bilingualContentWorkflowIds.includes(workflowId);
      const isScreenplay = screenplayWorkflowIds.includes(workflowId);
      const statusLabel = isLoading ? '正在读取已保存的' : '暂无已保存的';
      const contentDescription = isScreenplay ? 'Copilot 生成的剧本内容' : 'Copilot 生成的内容';
      generatedContentLabel.textContent = contentDescription + '：';
      generatedContent.setAttribute('aria-label', generatedContentLabel.textContent);
      generatedContent.placeholder = statusLabel + contentDescription;
      generatedResultZhLabel.textContent = isShootingScript
        ? 'Copilot 生成的中文拍摄脚本'
        : 'Copilot 生成的中文提示词';
      generatedResultEnLabel.textContent = isShootingScript
        ? 'Copilot 生成的英文拍摄脚本'
        : 'Copilot 生成的英文提示词';
      generatedResultZh.setAttribute('aria-label', generatedResultZhLabel.textContent);
      generatedResultEn.setAttribute('aria-label', generatedResultEnLabel.textContent);
      generatedResultZh.placeholder = statusLabel + generatedResultZhLabel.textContent;
      generatedResultEn.placeholder = statusLabel + generatedResultEnLabel.textContent;
      const copyLabel = '复制提示词';
      copyResultZhButton.textContent = copyLabel;
      copyResultEnButton.textContent = copyLabel;
      copyResultZhButton.title = copyLabel;
      copyResultEnButton.title = copyLabel;
      copyResultZhButton.setAttribute('aria-label', copyLabel);
      copyResultEnButton.setAttribute('aria-label', copyLabel);
    }

    function closeResultDialog() {
      resultDialog.close();
      viewingResultRecordId = undefined;
      viewingResultType = undefined;
      isResultLoaded = false;
    }

    // 按当前结果内容调整文本框高度，保持初始单行显示。
    function resizeResultTextareas() {
      [generatedContent, generatedResultZh, generatedResultEn].forEach((textarea) => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
    }

    function copyResult(textarea, button, defaultLabel) {
      navigator.clipboard.writeText(textarea.value).then(() => {
        resultError.hidden = true;
        const previousTimers = copyFeedbackTimers.get(button);
        if (previousTimers) {
          window.clearTimeout(previousTimers.fade);
          window.clearTimeout(previousTimers.reset);
        }

        button.classList.remove('is-fading');
        button.textContent = '复制成功';
        const fadeTimer = window.setTimeout(() => button.classList.add('is-fading'), 1000);
        const resetTimer = window.setTimeout(() => {
          button.textContent = defaultLabel;
          button.classList.remove('is-fading');
          copyFeedbackTimers.delete(button);
        }, 1300);
        copyFeedbackTimers.set(button, { fade: fadeTimer, reset: resetTimer });
      }).catch(() => {
        resultError.textContent = '复制内容失败，请检查剪贴板权限。';
        resultError.hidden = false;
      });
    }

    [generatedContent, generatedResultZh, generatedResultEn].forEach((textarea) => {
      textarea.addEventListener('input', resizeResultTextareas);
    });

    function renderState(state) {
      selectedCategoryId = state.categoryId;
      currentViewMode = state.viewMode;
      editingWorkProjectId = state.editingWorkProject?.id;
      const hasEpisodeContentColumns = episodeContentWorkflowIds.includes(state.categoryId);
      recordsTable.classList.toggle('has-episode-content-columns', hasEpisodeContentColumns);
      recordsTable.classList.toggle('has-project-columns', state.categoryId !== undefined);
      projects = state.projects;
      recordsSection.hidden = state.viewMode !== 'records';
      projectsSection.hidden = state.viewMode !== 'projects';
      createWorkProjectSection.hidden = state.viewMode !== 'create-project' && state.viewMode !== 'edit-project';
      renderProjectFilter([
        { value: 'all', label: '所有内容', isScopeOption: true },
        { value: '0', label: '未归属项目', isScopeOption: true },
        ...projects.map((project) => ({ value: project.id, label: project.name }))
      ], state.projectFilter);
      if (state.viewMode === 'projects') {
        renderWorkProjects(projects);
        return;
      }
      if (state.viewMode === 'create-project' || state.viewMode === 'edit-project') {
        const editingWorkProject = state.editingWorkProject;
        document.getElementById('project-form-title').textContent = editingWorkProject ? '编辑项目' : '创建项目';
        document.getElementById('save-project').textContent = editingWorkProject ? '保存' : '创建';
        projectNameInput.value = editingWorkProject?.name ?? '';
        projectDescriptionInput.value = editingWorkProject?.description ?? '';
        projectFormError.textContent = '';
        projectNameInput.focus();
        return;
      }
      recordList.replaceChildren();
      if (!state.records.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '暂无保存的数据';
        recordList.append(empty);
        return;
      }

      for (const record of state.records) {
        const row = document.createElement('div');
        row.className = 'record-row';
        row.setAttribute('role', 'row');
        const titleCell = document.createElement('span');
        titleCell.className = 'record-cell record-title';
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'record-title-button';
        title.textContent = record.title || '旧记录（无标题）';
        title.title = title.textContent;
        title.setAttribute('aria-label', '查看' + title.textContent + '的生成内容');
        title.addEventListener('click', () => {
          if (episodeContentWorkflowIds.includes(selectedCategoryId)) {
            openEpisodeContentDialog(record);
          } else {
            openResultDialog(record);
          }
        });
        titleCell.append(title);
        const projectName = document.createElement('span');
        projectName.className = 'record-cell project-column';
        projectName.textContent = record.projectId === '0' ? '-' : record.projectName || '-';
        projectName.title = projectName.textContent;
        const actions = document.createElement('div');
        actions.className = 'record-actions row-action-column';
        const runRecord = makeButton('运行生成', 'edit-button', '运行生成' + title.textContent, () => {
          vscode.postMessage({ command: 'run-record', recordId: record.id });
        });
        const editRecord = makeButton('编辑', 'edit-button', '编辑' + title.textContent, () => {
          vscode.postMessage({ command: 'select-record', recordId: record.id });
        });
        const remove = makeButton('删除', 'delete-button', '删除' + title.textContent, () => {
          openDeleteDialog(record);
        });
        if (hasEpisodeContentColumns) {
          const viewContentCell = document.createElement('span');
          viewContentCell.className = 'record-cell episode-content-action-column';
          const recordActions = document.createElement('div');
          recordActions.className = 'record-actions';
          recordActions.append(runRecord, editRecord);
          viewContentCell.append(recordActions);
          actions.append(remove);
          row.append(titleCell, projectName, makeTime(record.createdAt), makeGeneratedTime(record.generatedAt), viewContentCell, actions);
        } else {
          actions.append(runRecord, editRecord, remove);
          row.append(titleCell, projectName, makeTime(record.createdAt), makeGeneratedTime(record.generatedAt), actions);
        }
        recordList.append(row);
      }
    }

    function renderWorkProjects(items) {
      projectList.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '暂无项目';
        projectList.append(empty);
        return;
      }
      for (const project of items) {
        const row = document.createElement('div');
        row.className = 'record-row project-row';
        row.setAttribute('role', 'row');
        const name = document.createElement('span');
        name.className = 'record-cell record-title';
        name.textContent = project.name;
        name.title = project.name;
        const description = document.createElement('span');
        description.className = 'record-cell project-description';
        description.textContent = project.description;
        description.title = project.description;
        const actions = document.createElement('div');
        actions.className = 'record-actions';
        const edit = makeButton('编辑', 'edit-button', '编辑项目' + project.name, () => {
          vscode.postMessage({ command: 'edit-project', projectId: project.id });
        });
        const remove = makeButton('删除', 'delete-button', '删除项目' + project.name, () => {
          openWorkProjectDeleteWarning(project);
        });
        actions.append(edit, remove);
        row.append(name, description, makeTime(project.createdAt), actions);
        projectList.append(row);
      }
    }

    projectFilterTrigger.addEventListener('click', () => {
      if (projectFilterMenu.hidden) {
        openProjectFilterMenu();
      } else {
        closeProjectFilterMenu();
      }
    });
    projectFilterTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openProjectFilterMenu();
      }
    });
    projectFilterMenu.addEventListener('keydown', (event) => {
      const options = [...projectFilterMenu.querySelectorAll('[role="option"]')];
      const currentIndex = options.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeProjectFilterMenu(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        options[Math.max(0, Math.min(currentIndex + offset, options.length - 1))]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!projectFilter.contains(event.target)) closeProjectFilterMenu();
    });

    projectForm.addEventListener('submit', (event) => {
      event.preventDefault();
      projectFormError.textContent = '';
      vscode.postMessage({
        command: currentViewMode === 'edit-project' ? 'update-project' : 'submit-project',
        ...(currentViewMode === 'edit-project' ? { projectId: editingWorkProjectId } : {}),
        projectName: projectNameInput.value,
        projectDescription: projectDescriptionInput.value
      });
    });
    document.getElementById('cancel-project-create').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel-project-create' });
    });

    deleteTitle.addEventListener('input', () => {
      confirmDelete.disabled = !pendingDelete || deleteTitle.value !== pendingDelete.title;
      deleteError.hidden = true;
    });

    deleteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!pendingDelete || deleteTitle.value !== pendingDelete.title) {
        deleteError.textContent = '输入的标题与记录标题不一致。';
        deleteError.hidden = false;
        confirmDelete.disabled = true;
        return;
      }

      confirmDelete.disabled = true;
      vscode.postMessage({
        command: pendingDelete.kind === 'project' ? 'delete-project' : 'delete-record',
        ...(pendingDelete.kind === 'project' ? { projectId: pendingDelete.id } : { recordId: pendingDelete.id }),
        confirmationTitle: deleteTitle.value
      });
    });

    document.getElementById('cancel-delete').addEventListener('click', closeDeleteDialog);
    document.getElementById('close-delete').addEventListener('click', closeDeleteDialog);
    document.getElementById('cancel-project-warning').addEventListener('click', () => {
      projectWarningDialog.close();
      pendingDelete = undefined;
    });
    document.getElementById('close-project-warning').addEventListener('click', () => {
      projectWarningDialog.close();
      pendingDelete = undefined;
    });
    document.getElementById('continue-project-delete').addEventListener('click', () => {
      if (!pendingDelete || pendingDelete.kind !== 'project') return;
      projectWarningDialog.close();
      showDeleteNameDialog('项目', pendingDelete.title);
    });
    document.getElementById('close-result').addEventListener('click', closeResultDialog);
    document.getElementById('close-episode-content').addEventListener('click', closeEpisodeContentDialog);
    episodeContentDialog.addEventListener('cancel', () => {
      viewingEpisodeRecordId = undefined;
    });
    copyContentButton.addEventListener('click', () => copyResult(generatedContent, copyContentButton, '复制内容'));
    copyResultZhButton.addEventListener('click', () => copyResult(generatedResultZh, copyResultZhButton, '复制提示词'));
    copyResultEnButton.addEventListener('click', () => copyResult(generatedResultEn, copyResultEnButton, '复制提示词'));
    editResultButton.addEventListener('click', () => {
      if (!viewingResultRecordId || !isResultLoaded) return;
      editResultButton.disabled = true;
      resultError.textContent = '';
      resultError.hidden = true;
      vscode.postMessage({
        command: 'save-generated-result',
        recordId: viewingResultRecordId,
        ...(viewingResultType === 'content'
          ? { content: generatedContent.value }
          : { contentZh: generatedResultZh.value, contentEn: generatedResultEn.value })
      });
    });
    resultDialog.addEventListener('cancel', () => {
      viewingResultRecordId = undefined;
      viewingResultType = undefined;
      isResultLoaded = false;
    });
    deleteDialog.addEventListener('cancel', () => {
      pendingDelete = undefined;
      deleteTitle.value = '';
      confirmDelete.disabled = true;
    });
    projectWarningDialog.addEventListener('cancel', () => {
      pendingDelete = undefined;
    });

    window.addEventListener('message', (event) => {
      if (event.data.command === 'state') renderState(event.data);
      if (event.data.command === 'generated-episodes' && event.data.recordId === viewingEpisodeRecordId) {
        renderEpisodeContents(event.data.episodes);
      }
      if (event.data.command === 'project-create-error') projectFormError.textContent = event.data.text;
      if (event.data.command === 'delete-success') closeDeleteDialog();
      if (event.data.command === 'generated-result' && event.data.recordId === viewingResultRecordId) {
        viewingResultType = event.data.resultType;
        const isContent = viewingResultType === 'content';
        const isBilingualContent = viewingResultType === 'bilingual-content';
        contentResultField.hidden = !isContent;
        promptResultFields.hidden = isContent && !isBilingualContent;
        resultDialogTitle.textContent = getResultActionLabel(selectedCategoryId) + '：' + event.data.title;
        configureResultLabels(selectedCategoryId, false);
        generatedContent.value = event.data.content ?? '';
        generatedResultZh.value = event.data.contentZh ?? '';
        generatedResultEn.value = event.data.contentEn ?? '';
        resizeResultTextareas();
        isResultLoaded = true;
        editResultButton.disabled = false;
        copyContentButton.disabled = false;
        copyResultZhButton.disabled = false;
        copyResultEnButton.disabled = false;
      }
      if (event.data.command === 'generated-result-saved' && event.data.recordId === viewingResultRecordId) {
        editResultButton.disabled = false;
        resultError.hidden = true;
      }
      if (event.data.command === 'generated-result-save-error' && event.data.recordId === viewingResultRecordId) {
        resultError.textContent = event.data.text;
        resultError.hidden = false;
        editResultButton.disabled = false;
      }
      if (event.data.command === 'delete-error') {
        deleteError.textContent = event.data.text;
        deleteError.hidden = false;
        confirmDelete.disabled = !pendingDelete || deleteTitle.value !== pendingDelete.title;
      }
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const values = new Uint8Array(24);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}
