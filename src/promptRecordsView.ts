import * as vscode from 'vscode';
import { GeneratedContentTask, PromptDatabase, PromptRecord, UNIQUE_CONTENT_TASK_WORKFLOW_NAMES } from './database';
import {
  parseOriginalSourceFile,
  renderAddRecordFields,
  validateWorkflowFormValues
} from './formPanel';
import { GeneratedChapterContent } from './chapterContent';
import {
  FormField,
  FormValues,
  FormWorkflow,
  getWorkflowResultType,
  ORIGINAL_SOURCE_FILE_FIELD,
  TASK_NAME_FIELD,
  SCREENPLAY_WORKFLOW_NAME,
  SHOOTING_SCRIPT_WORKFLOW_NAME
} from './formWorkflows';
import { WorkflowSubmissionStore } from './workflowFormTool';

interface ViewMessage {
  readonly command: string;
  readonly categoryId?: string;
  readonly recordId?: string;
  readonly mode?: string;
  readonly confirmationTitle?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectDescription?: string;
  readonly values?: unknown;
  readonly content?: string;
  readonly contentZh?: string;
  readonly contentEn?: string;
}

interface RecordsPanelSession {
  readonly key: string;
  readonly panel: vscode.WebviewPanel;
  readonly subscriptions: vscode.Disposable[];
  categoryId: string | undefined;
  viewMode: 'records' | 'projects';
  projectFilter: string;
  ready: boolean;
  pendingAddRecordCategoryId: string | undefined;
  pendingProjectDialog: 'create' | undefined;
}

/** Provides an editor-area page for managing saved prompt records. */
export class PromptRecordsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly panels = new Map<string, RecordsPanelSession>();
  private categoryView: vscode.Webview | undefined;
  private selectedCategoryId: string | undefined;
  private selectedProjectManagement = false;
  private categoryMessageSubscription: vscode.Disposable | undefined;
  private visibilitySubscription: vscode.Disposable | undefined;
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
    this.categoryMessageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleCategoryMessage(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(errorMessage(error));
      });
    });
    view.webview.html = createCategoryHtml();
    this.visibilitySubscription = view.onDidChangeVisibility(() => {
      this.postState();
    });
  }

  private open(categoryId: string | undefined, viewMode: 'records' | 'projects'): RecordsPanelSession {
    const key = categoryId ?? '__projects__';
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return existing;
    }

    const selectedCategoryTitle = viewMode === 'projects' ? '项目管理'
      : this.workflows.find((workflow) => workflow.toolName === categoryId)?.title ?? '请选择任务';
    const panel = vscode.window.createWebviewPanel(
      'aiVideoCreation.promptRecordsEditor',
      selectedCategoryTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    const session: RecordsPanelSession = {
      key,
      panel,
      subscriptions: [],
      categoryId,
      viewMode,
      projectFilter: 'all',
      ready: false,
      pendingAddRecordCategoryId: undefined,
      pendingProjectDialog: undefined
    };
    this.panels.set(key, session);
    session.subscriptions.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handlePanelMessage(message, session).catch((error: unknown) => {
          void vscode.window.showErrorMessage(errorMessage(error));
        });
      }),
      panel.onDidChangeViewState((event) => {
        if (!event.webviewPanel.active) {
          return;
        }
        this.selectedCategoryId = session.viewMode === 'records' ? session.categoryId : undefined;
        this.selectedProjectManagement = session.viewMode === 'projects';
        this.postState();
      }),
      panel.onDidDispose(() => {
        if (this.panels.get(key) === session) this.panels.delete(key);
        if (this.selectedCategoryId === session.categoryId) {
          const activeSession = [...this.panels.values()].find((item) => item.panel.active);
          this.selectedCategoryId = activeSession?.viewMode === 'records'
            ? activeSession.categoryId
            : undefined;
          this.selectedProjectManagement = activeSession?.viewMode === 'projects';
          this.postState();
        }
        this.disposePanelSession(session);
      })
    );
    panel.webview.html = createPageHtml(this.workflows);
    return session;
  }

  dispose(): void {
    this.categoryMessageSubscription?.dispose();
    this.visibilitySubscription?.dispose();
    this.databaseSubscription.dispose();
    for (const session of this.panels.values()) {
      session.panel.dispose();
      this.disposePanelSession(session);
    }
    this.panels.clear();
    this.categoryView = undefined;
  }

  private disposePanelSession(session: RecordsPanelSession): void {
    for (const subscription of session.subscriptions.splice(0)) {
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
      this.selectedProjectManagement = false;
      const session = this.open(message.categoryId, 'records');
      this.postState(session);
      return;
    }

    if (message.command === 'open-projects') {
      this.selectedCategoryId = undefined;
      this.selectedProjectManagement = true;
      const session = this.open(undefined, 'projects');
      this.postState(session);
      return;
    }

    if (message.command === 'add-record') {
      const workflow = this.findWorkflow(message.categoryId);
      this.selectedCategoryId = workflow.toolName;
      this.selectedProjectManagement = false;
      const session = this.open(workflow.toolName, 'records');
      session.pendingAddRecordCategoryId = workflow.toolName;
      this.postState(session);
      this.openPendingAddRecordDialog(session);
      return;
    }

    if (message.command === 'create-project') {
      this.openCreateProjectDialog();
    }

  }

  private async handlePanelMessage(value: unknown, session: RecordsPanelSession): Promise<void> {
    if (!isRecord(value) || typeof value.command !== 'string') {
      return;
    }

    const message = value as unknown as ViewMessage;
    if (message.command === 'ready') {
      session.ready = true;
      this.postState(session);
      this.openPendingAddRecordDialog(session);
      this.openPendingProjectDialog(session);
      return;
    }
    if (message.command === 'save-add-record') {
      this.saveAddedRecord(message, session);
      return;
    }
    if (message.command === 'update-record') {
      this.saveEditedRecord(message, session);
      return;
    }
    if (message.command === 'create-project') {
      this.openCreateProjectDialog(session);
      return;
    }
    if (message.command === 'submit-project') {
      try {
        this.createWorkProject(message.projectName, message.projectDescription, session);
        void session.panel.webview.postMessage({ command: 'project-saved' });
      } catch (error) {
        void session.panel.webview.postMessage({ command: 'project-create-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'update-project') {
      try {
        this.updateWorkProject(message.projectId, message.projectName, message.projectDescription, session);
        void session.panel.webview.postMessage({ command: 'project-saved' });
      } catch (error) {
        void session.panel.webview.postMessage({ command: 'project-create-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'select-record') {
      this.editRecord(message.recordId, session);
      return;
    }
    if (message.command === 'run-record') {
      await this.runRecord(message.recordId);
      return;
    }
    if (message.command === 'project-filter') {
      if (typeof message.projectId !== 'string' ||
          (message.projectId !== 'all' &&
           !this.database.listWorkProjects().some((project) => project.id === message.projectId))) {
        throw new Error('项目筛选条件无效。');
      }
      session.projectFilter = message.projectId;
      this.postState(session);
      return;
    }
    if (message.command === 'edit-project') {
      this.editWorkProject(message.projectId, session);
      return;
    }
    if (message.command === 'delete-project') {
      try {
        this.deleteWorkProject(message.projectId, message.confirmationTitle, session);
      } catch (error) {
        void session.panel.webview.postMessage({ command: 'delete-error', text: errorMessage(error) });
      }
      return;
    }
    if (message.command === 'view-result') {
      this.postGeneratedResult(message.recordId, session);
      return;
    }
    if (message.command === 'view-chapters') {
      this.postGeneratedChapters(message.recordId, session);
      return;
    }
    if (message.command === 'save-generated-result') {
      try {
        this.saveGeneratedResult(message.recordId, message.content, message.contentZh, message.contentEn, session);
      } catch (error) {
        void session.panel.webview.postMessage({
          command: 'generated-result-save-error',
          recordId: message.recordId,
          text: errorMessage(error)
        });
      }
      return;
    }
    if (message.command === 'delete-record') {
      try {
        this.deleteRecord(message.recordId, message.confirmationTitle, session);
      } catch (error) {
        void session.panel.webview.postMessage({
          command: 'delete-error',
          text: errorMessage(error)
        });
      }
    }
  }

  /** 核对用户输入的标题后删除记录。 */
  private deleteRecord(
    recordId: string | undefined,
    confirmationTitle: string | undefined,
    session: RecordsPanelSession
  ): void {
    if (typeof recordId !== 'string' || typeof confirmationTitle !== 'string') {
      throw new Error('删除记录所需信息缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('记录不存在或已被删除。');
    }

    const expectedTaskName = record.taskName;
    if (confirmationTitle !== expectedTaskName) {
      throw new Error('输入的名称与任务名称不一致，未删除。');
    }
    if (!this.database.deleteRecord(record.id)) {
      throw new Error('删除记录失败。');
    }

    void session.panel.webview.postMessage({ command: 'delete-success' });
  }

  /** 按需向记录页面发送指定记录的 Copilot 返回内容。 */
  private postGeneratedResult(recordId: string | undefined, session: RecordsPanelSession): void {
    if (typeof recordId !== 'string') {
      throw new Error('查看生成结果所需的记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要查看的提示词记录不存在。');
    }

    const isBilingualContent = record.categoryId === SHOOTING_SCRIPT_WORKFLOW_NAME;
    const isContent = getWorkflowResultType(record.categoryId) === 'content';
    void session.panel.webview.postMessage({
      command: 'generated-result',
      recordId: record.id,
      taskName: record.taskName,
      resultType: isBilingualContent ? 'bilingual-content' : isContent ? 'content' : 'prompt',
      ...(isContent && !isBilingualContent
        ? { content: record.generatedResultContent ?? '' }
        : {
            contentZh: record.generatedResultChinese ?? '',
            contentEn: record.generatedResultEnglish ?? ''
          })
    });
  }

  /** 按需向记录页面发送指定创作任务的章节内容。 */
  private postGeneratedChapters(recordId: string | undefined, session: RecordsPanelSession): void {
    if (typeof recordId !== 'string') {
      throw new Error('查看章节内容所需的记录标识缺失。');
    }
    const record = this.database.getRecord(recordId);
    if (!record || !this.workflows.some((workflow) =>
      workflow.toolName === record.categoryId && workflow.supportsChapterContent === true
    )) {
      throw new Error('要查看的章节创作任务不存在。');
    }
    const chapters: GeneratedChapterContent[] = this.database.listGeneratedChapterContents(recordId);
    void session.panel.webview.postMessage({
      command: 'generated-chapters',
      recordId,
      taskName: record.taskName,
      chapters
    });
  }

  /** 保存用户在结果弹层中修改的作品内容或双语提示词。 */
  private saveGeneratedResult(
    recordId: string | undefined,
    content: string | undefined,
    contentZh: string | undefined,
    contentEn: string | undefined,
    session: RecordsPanelSession
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

    void session.panel.webview.postMessage({
      command: 'generated-result-saved',
      recordId
    });
  }

  private openPendingAddRecordDialog(session: RecordsPanelSession): void {
    if (!session.ready || !session.pendingAddRecordCategoryId) {
      return;
    }
    const workflow = this.findWorkflow(session.pendingAddRecordCategoryId);
    session.pendingAddRecordCategoryId = undefined;
    void session.panel.webview.postMessage({
      command: 'open-add-record-dialog',
      categoryId: workflow.toolName,
      title: `添加${workflow.title}信息`,
      formFields: renderAddRecordFields(workflow, this.database.listWorkProjects(), {}, this.listGeneratedContentTasks()),
      supportsImageAttachments: workflow.supportsImageAttachments === true
    });
  }

  private listGeneratedContentTasks(): GeneratedContentTask[] {
    const contentWorkflows = this.workflows.filter((workflow) => workflow.resultType === 'content');
    const chapterWorkflowIds = contentWorkflows
      .filter((workflow) => workflow.supportsChapterContent === true)
      .map((workflow) => workflow.toolName);
    return this.database.listGeneratedContentTasks(
      contentWorkflows.map((workflow) => workflow.toolName),
      chapterWorkflowIds
    );
  }

  private assertProjectContentTask(workflow: FormWorkflow, values: FormValues, projectId: string): void {
    const sourceTaskField = workflow.fields.find((field) => field.projectContentTask);
    if (sourceTaskField && !this.listGeneratedContentTasks().some((task) =>
      task.id === values[sourceTaskField.name] && task.projectId === projectId &&
      (!sourceTaskField.projectTaskCategory || task.categoryId === sourceTaskField.projectTaskCategory)
    )) {
      throw new Error('请选择当前项目中已有生成内容的创作任务。');
    }
  }

  private recordTaskName(workflow: FormWorkflow, values: FormValues): string {
    return workflow.toolName === SCREENPLAY_WORKFLOW_NAME || workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME
      ? ''
      : values.taskName;
  }

  private assertUniqueContentTaskName(workflow: FormWorkflow, taskName: string, excludeRecordId?: string): void {
    if (UNIQUE_CONTENT_TASK_WORKFLOW_NAMES.some((categoryId) => categoryId === workflow.toolName)) {
      this.database.assertTaskNameUnique(taskName, UNIQUE_CONTENT_TASK_WORKFLOW_NAMES, excludeRecordId);
    }
  }

  private saveAddedRecord(message: ViewMessage, session: RecordsPanelSession): void {
    let workflow: FormWorkflow;
    let values: FormValues | undefined;
    try {
      workflow = this.findWorkflow(message.categoryId);
      values = validateWorkflowFormValues(message.values, workflow);
      if (!values || typeof message.projectId !== 'string' ||
          (workflow.requiresProject && message.projectId === '0') ||
          (message.projectId !== '0' &&
           !this.database.listWorkProjects().some((project) => project.id === message.projectId))) {
        throw new Error('表单数据无效，请检查后重新提交。');
      }
      this.assertProjectContentTask(workflow, values, message.projectId);
      const taskName = this.recordTaskName(workflow, values);
      this.assertUniqueContentTaskName(workflow, taskName);
      this.database.saveRecord({
        taskName,
        categoryId: workflow.toolName,
        categoryName: workflow.title,
        projectId: message.projectId,
        schema: workflow.fields,
        data: values
      });
    } catch (error) {
      void session.panel.webview.postMessage({
        command: 'add-record-error',
        text: errorMessage(error)
      });
      return;
    }

    this.selectedCategoryId = workflow.toolName;
    session.categoryId = workflow.toolName;
    session.viewMode = 'records';
    this.postState(session);
    void session.panel.webview.postMessage({ command: 'add-record-saved' });
  }

  private editRecord(recordId: string | undefined, session: RecordsPanelSession): void {
    if (typeof recordId !== 'string') {
      throw new Error('记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要修改的记录不存在。');
    }

    const workflow = this.findWorkflow(record.categoryId);
    const savedFields = readFormFields(record.schema);
    const fields = workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME || workflow.toolName === SCREENPLAY_WORKFLOW_NAME
      ? workflow.fields
      : savedFields.some((field) => field.name === 'taskName')
      ? savedFields
      : [TASK_NAME_FIELD, ...savedFields];
    const editableFields = fields.map((field) =>
      workflow.toolName === SCREENPLAY_WORKFLOW_NAME && field.name === 'sourceTaskId'
        ? { ...field, label: '关联内容创作任务' }
        : field
    );
    const recordValues = readFormValues(record.data);
    const initialValues: FormValues = { ...recordValues, projectId: record.projectId };
    if (workflow.toolName === SCREENPLAY_WORKFLOW_NAME || workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME) {
      delete initialValues.taskName;
    } else {
      initialValues.taskName = record.taskName;
    }
    const editWorkflow: FormWorkflow = { ...workflow, fields: editableFields };
    void session.panel.webview.postMessage({
      command: 'open-add-record-dialog',
      mode: 'edit',
      recordId: record.id,
      categoryId: workflow.toolName,
      title: `编辑${workflow.title}信息`,
      formFields: renderAddRecordFields(editWorkflow, this.database.listWorkProjects(), initialValues, this.listGeneratedContentTasks()),
      supportsImageAttachments: workflow.supportsImageAttachments === true
    });
  }

  private saveEditedRecord(message: ViewMessage, session: RecordsPanelSession): void {
    try {
      if (typeof message.recordId !== 'string') {
        throw new Error('记录标识缺失。');
      }
      const record = this.database.getRecord(message.recordId);
      if (!record) {
        throw new Error('记录不存在或已被删除。');
      }
      const workflow = this.findWorkflow(record.categoryId);
      const savedFields = readFormFields(record.schema);
      const fields = workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME || workflow.toolName === SCREENPLAY_WORKFLOW_NAME
        ? workflow.fields
        : savedFields.some((field) => field.name === 'taskName')
        ? savedFields
        : [TASK_NAME_FIELD, ...savedFields];
      const editableFields = fields.map((field) =>
        workflow.toolName === SCREENPLAY_WORKFLOW_NAME && field.name === 'sourceTaskId'
          ? { ...field, label: '关联内容创作任务' }
          : field
      );
      const values = validateWorkflowFormValues(message.values, { ...workflow, fields: editableFields });
      if (!values || typeof message.projectId !== 'string' ||
          (workflow.requiresProject && message.projectId === '0') ||
          (message.projectId !== '0' &&
           !this.database.listWorkProjects().some((project) => project.id === message.projectId))) {
        throw new Error('表单数据无效，请检查后重新提交。');
      }
      this.assertProjectContentTask(workflow, values, message.projectId);
      const taskName = this.recordTaskName(workflow, values);
      this.assertUniqueContentTaskName(workflow, taskName, record.id);
      const updatedRecord = this.database.updateRecord(record.id, {
        taskName,
        projectId: message.projectId,
        schema: editableFields,
        data: values
      });
      if (!updatedRecord) {
        throw new Error('记录已不存在，无法保存修改。');
      }
      this.selectedCategoryId = record.categoryId;
      session.categoryId = record.categoryId;
      session.viewMode = 'records';
      this.postState(session);
      void session.panel.webview.postMessage({ command: 'record-updated' });
    } catch (error) {
      void session.panel.webview.postMessage({
        command: 'update-record-error',
        text: errorMessage(error)
      });
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
    if (workflow.requiresProject && record.projectId === '0') {
      throw new Error('剧本创作记录必须归属项目后才能运行。');
    }
    const values = readFormValues(record.data);
    this.assertProjectContentTask(workflow, values, record.projectId);
    if (workflow.supportsOriginalSourceFile && !parseOriginalSourceFile(values[ORIGINAL_SOURCE_FILE_FIELD])) {
      throw new Error('请先编辑任务并上传原作 TXT 或 Markdown 文件，再运行小说重创作。');
    }
    await this.runSubmittedPrompt(workflow, values, record.id);
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
  private createWorkProject(
    name: string | undefined,
    description: string | undefined,
    session: RecordsPanelSession
  ): void {
    if (typeof name !== 'string' || typeof description !== 'string' || !name.trim()) {
      throw new Error('项目名称不能为空，项目简介必须是文本。');
    }
    this.database.createWorkProject({ name, description });
    session.categoryId = undefined;
    session.viewMode = 'projects';
    this.postState(session);
  }

  private openCreateProjectDialog(currentSession?: RecordsPanelSession): void {
    const session = currentSession ?? this.open(undefined, 'projects');
    session.viewMode = 'projects';
    session.categoryId = undefined;
    this.selectedCategoryId = undefined;
    this.selectedProjectManagement = true;
    session.pendingProjectDialog = 'create';
    this.postState(session);
    this.openPendingProjectDialog(session);
  }

  private openPendingProjectDialog(session: RecordsPanelSession): void {
    if (!session.ready || !session.pendingProjectDialog) {
      return;
    }
    const mode = session.pendingProjectDialog;
    session.pendingProjectDialog = undefined;
    void session.panel.webview.postMessage({ command: 'open-project-dialog', mode });
  }

  /** 在项目列表上打开指定项目的编辑对话框。 */
  private editWorkProject(projectId: string | undefined, session: RecordsPanelSession): void {
    if (typeof projectId !== 'string') {
      throw new Error('项目标识缺失。');
    }
    const project = this.database.listWorkProjects().find((item) => item.id === projectId);
    if (!project) {
      throw new Error('项目不存在或已被删除。');
    }
    void session.panel.webview.postMessage({
      command: 'open-project-dialog',
      mode: 'edit',
      projectId: project.id,
      projectName: project.name,
      projectDescription: project.description
    });
  }

  /** 校验编辑页面提交的数据并更新项目。 */
  private updateWorkProject(
    projectId: string | undefined,
    name: string | undefined,
    description: string | undefined,
    session: RecordsPanelSession
  ): void {
    if (typeof projectId !== 'string' || typeof name !== 'string' ||
        typeof description !== 'string' || !name.trim()) {
      throw new Error('项目标识无效，项目名称不能为空，描述必须是文本。');
    }
    if (!this.database.updateWorkProject(projectId, { name, description })) {
      throw new Error('项目已不存在，无法保存修改。');
    }
    session.categoryId = undefined;
    session.viewMode = 'projects';
    this.postState(session);
  }

  /** 校验确认名称后删除项目及其关联记录。 */
  private deleteWorkProject(
    projectId: string | undefined,
    confirmationTitle: string | undefined,
    session: RecordsPanelSession
  ): void {
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
    if (session.projectFilter === project.id) {
      session.projectFilter = 'all';
    }
    if (!this.database.deleteWorkProject(project.id)) {
      throw new Error('删除项目失败。');
    }
    void session.panel.webview.postMessage({ command: 'delete-success' });
  }

  private findWorkflow(categoryId: string | undefined): FormWorkflow {
    const workflow = this.workflows.find((item) => item.toolName === categoryId);
    if (!workflow) {
      throw new Error('提示词分类标识无效。');
    }
    return workflow;
  }

  private postState(targetSession?: RecordsPanelSession): void {
    const categories = this.workflows.map((workflow) => ({
      id: workflow.toolName,
      title: workflow.title
    }));
    if (this.categoryView) {
      void this.categoryView.postMessage({
        command: 'categories',
        categories,
        selectedCategoryId: this.selectedCategoryId,
        selectedProjectManagement: this.selectedProjectManagement
      });
    }

    const projects = this.database.listWorkProjects();
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const contentTaskNames = new Map(this.listGeneratedContentTasks().map((task) => [task.id, task.taskName]));
    const sessions = targetSession ? [targetSession] : this.panels.values();
    for (const session of sessions) {
      const selectedCategory = this.workflows.find((workflow) => workflow.toolName === session.categoryId);
      const categoryTitle = session.viewMode === 'projects'
        ? '项目管理'
        : selectedCategory?.title ?? '请选择任务';
      session.panel.title = categoryTitle;
      const records = (session.viewMode !== 'records' || session.categoryId === undefined
        ? []
        : this.database.listRecords(
          session.categoryId,
          session.projectFilter === 'all' ? undefined : session.projectFilter
        )).map((record) => {
        const recordValues = readFormValues(record.data);
        const linkedTaskId = record.categoryId === SCREENPLAY_WORKFLOW_NAME
          ? recordValues.sourceTaskId
          : record.categoryId === SHOOTING_SCRIPT_WORKFLOW_NAME
          ? recordValues.screenplayTaskId
          : undefined;
        return {
          id: record.id,
          taskName: linkedTaskId ? contentTaskNames.get(linkedTaskId) ?? record.taskName : record.taskName,
          projectId: record.projectId,
          projectName: projectNames.get(record.projectId),
          createdAt: record.createdAt,
          generatedAt: record.generatedAt
        };
      });

      void session.panel.webview.postMessage({
        command: 'state',
        viewMode: session.viewMode,
        categoryId: session.categoryId,
        categoryTitle,
        records,
        projects,
        projectFilter: session.projectFilter
      });
    }
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
    #category-list { display: grid; gap: 10px; }
    h2 {
      display: flex; align-items: center; gap: 8px;
      margin: 0 0 8px; padding: 2px 0; color: var(--vscode-foreground); font-size: 12px; font-weight: 600;
    }
    h2::before {
      width: 3px; height: 16px; flex: 0 0 auto;
      background: var(--vscode-focusBorder); border-radius: 2px; content: "";
    }
    nav { display: grid; gap: 0; }
    .category-item {
      position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0; padding: 0 0 0 2px;
      background: transparent; border: 0; border-radius: 4px;
    }
    .category-item + .category-item { margin-top: 4px; }
    .category-item:hover,
    .category-item.is-selected { background: var(--menu-hover-background); }
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
    <div id="category-list"></div>
    <section class="card">
      <div class="card-inner config-card">
        <h2>管理</h2>
        <nav aria-label="设置">
          <div class="category-item">
            <button id="open-projects" class="select" type="button">项目管理</button>
            <button id="create-project" class="add" type="button">创建</button>
          </div>
          <div class="category-item">
            <button id="open-model-config" class="select" type="button">模型配置（预览）</button>
            <button id="add-model-config" class="add" type="button">添加</button>
          </div>
          <div class="category-item">
            <button id="open-database-backup" class="select" type="button">数据库备份（预览）</button>
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
    const databaseBackupItem = document.querySelectorAll('.config-card .category-item')[2];
    const openDatabaseBackupButton = document.getElementById('open-database-backup');
    if (!(settingsItem instanceof HTMLElement) ||
        !(openProjectsButton instanceof HTMLButtonElement) ||
        !(createProjectButton instanceof HTMLButtonElement) ||
        !(modelConfigItem instanceof HTMLElement) ||
        !(openModelConfigButton instanceof HTMLButtonElement) ||
      !(addModelConfigButton instanceof HTMLButtonElement) ||
      !(databaseBackupItem instanceof HTMLElement) ||
      !(openDatabaseBackupButton instanceof HTMLButtonElement)) {
      throw new Error('设置菜单项缺失。');
    }
    bindPressedState(openProjectsButton, settingsItem, true);
    bindPressedState(createProjectButton, settingsItem, false);
    bindPressedState(openModelConfigButton, modelConfigItem, true);
    bindPressedState(addModelConfigButton, modelConfigItem, false);
    bindPressedState(openDatabaseBackupButton, databaseBackupItem, true);
    document.getElementById('open-projects').addEventListener('click', () => {
      vscode.postMessage({ command: 'open-projects' });
    });
    document.getElementById('create-project').addEventListener('click', () => {
      vscode.postMessage({ command: 'create-project' });
    });
    const categoryStages = [
      {
        title: '内容创作',
        categoryIds: [
          'ai-video-creation-tools_collect_creative_writing_parameters',
          'ai-video-creation-tools_collect_image_inspired_writing_parameters',
          'ai-video-creation-tools_collect_novel_parameters'
        ]
      },
      {
        title: '资产',
        categoryIds: [
          'ai-video-creation-tools_collect_character_parameters',
          'ai-video-creation-tools_collect_scene_parameters',
          'ai-video-creation-tools_collect_prop_parameters',
          'ai-video-creation-tools_collect_effect_parameters'
        ]
      },
      {
        title: '拍摄',
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
      settingsItem.classList.toggle('is-selected', state.selectedProjectManagement);
      openProjectsButton.setAttribute('aria-pressed', String(state.selectedProjectManagement));
      for (let index = 0; index < categoryStages.length; index++) {
        const stage = categoryStages[index];
        const section = document.createElement('section');
        section.className = 'card category-stage';
        const cardInner = document.createElement('div');
        cardInner.className = 'card-inner';
        const heading = document.createElement('h2');
        heading.id = 'category-heading-' + index;
        heading.textContent = stage.title;
        section.setAttribute('aria-labelledby', heading.id);
        const categoryItems = document.createElement('nav');
        categoryItems.setAttribute('aria-label', stage.title);
        cardInner.append(heading, categoryItems);
        section.append(cardInner);

        for (const categoryId of stage.categoryIds) {
          const category = state.categories.find((item) => item.id === categoryId);
          if (!category) {
            throw new Error('创作阶段分类缺失：' + categoryId);
          }

          const item = document.createElement('div');
          const isSelected = state.selectedCategoryId === category.id;
          item.className = isSelected ? 'category-item is-selected' : 'category-item';
          const select = makeButton(category.title, 'select', category.title, () => {
            vscode.postMessage({ command: 'select-category', categoryId: category.id });
          });
          select.setAttribute('aria-pressed', String(isSelected));
          bindPressedState(select, item, true);
          const add = makeButton('添加', 'add', '添加' + category.title + '记录', () => {
            vscode.postMessage({ command: 'add-record', categoryId: category.id });
          });
          bindPressedState(add, item, false);
          item.append(select, add);
          categoryItems.append(item);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
    .table.has-chapter-content-columns .table-header, .table.has-chapter-content-columns .record-row { grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) minmax(112px, 1fr) 112px max-content; }
    #records-table:not(.has-project-columns) .project-column { display: none; }
    #records-table:not(.has-chapter-content-columns) .chapter-content-action-column { display: none; }
    #records-table.has-chapter-content-columns .row-action-column { display: none; }
    #records-table.has-chapter-content-columns .chapter-content-action-column { text-align: left; }
    #records-table.has-chapter-content-columns .chapter-content-action-column > .record-actions { justify-content: flex-start; }
    #records-table .record-actions { margin-left: -8px; }
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
    .filter-toolbar { display: flex; width: 100%; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
    .project-filter { position: relative; width: fit-content; max-width: 100%; min-width: 0; }
    .project-filter-trigger {
      display: flex; width: max-content; max-width: 100%; min-height: 32px; align-items: center; justify-content: space-between;
      gap: 12px; padding: 4px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; text-align: left;
    }
    .project-filter-trigger.is-scope-filter { color: var(--vscode-textLink-foreground); }
    .project-filter-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .project-filter-label { min-width: 0; max-width: min(360px, calc(100vw - 100px)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-filter-chevron {
      width: 8px; height: 8px; flex: 0 0 auto; margin: -4px 2px 0 0;
      border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg);
    }
    .project-filter-menu {
      position: absolute; z-index: 5; top: calc(100% + 2px); right: 0; left: auto; width: max-content; min-width: 100%;
      max-width: min(420px, calc(100vw - 56px)); max-height: 240px; overflow: auto; padding: 3px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 3px; box-shadow: 0 3px 8px var(--vscode-widget-shadow);
    }
    .project-filter-menu[hidden] { display: none; }
    .project-filter-option {
      display: block; width: max-content; min-width: 100%; max-width: 100%; min-height: 32px; padding: 5px 9px; overflow: hidden;
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
    #project-dialog { width: min(560px, calc(100vw - 32px)); }
    .project-form { display: grid; min-width: 0; gap: 14px; }
    .project-dialog-body { display: grid; gap: 14px; }
    .project-form h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .project-form label { display: block; margin-bottom: 6px; font-weight: 600; }
    .project-form input, .project-form textarea {
      width: 100%; padding: 8px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit;
    }
    .project-form input { min-height: 34px; }
    .project-form textarea { min-height: 34px; max-height: 240px; resize: vertical; }
    .project-form input:focus, .project-form textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .project-form-error { min-height: 18px; margin: 0; color: var(--vscode-errorForeground); }
    .project-form-actions { display: flex; justify-content: flex-start; gap: 8px; }
    .delete-button {
      min-width: 44px; padding: 5px 8px; border: 0; border-radius: 3px;
      color: var(--vscode-errorForeground); background: transparent;
    }
    .delete-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .delete-button:focus-visible { outline: none; background: var(--vscode-toolbar-hoverBackground); }
    .empty { width: 100%; padding: 24px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
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
    .delete-title-highlight { padding: 2px 5px; color: #FFFFFF; background: #522522; border-radius: 3px; }
    body.vscode-dark .delete-title-highlight { background: #4E211F; }
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
    #delete-form .dialog-actions { gap: 6px; margin-top: 14px; }
    .dialog-save-button { min-height: 28px; padding: 3px 8px; }
    .dialog-cancel-button {
      min-height: 28px; padding: 3px 8px; color: #252525; background: #D2D2D2;
      border: 1px solid #A8A8A8; border-radius: 3px; font: inherit;
    }
    .dialog-cancel-button:hover { background: #BDBDBD; }
    .dialog-cancel-button:active { background: #A8A8A8; }
    body.vscode-dark .dialog-cancel-button { color: #F3F3F3; background: #414141; border-color: #5A5A5A; }
    body.vscode-dark .dialog-cancel-button:hover { background: #505050; }
    body.vscode-dark .dialog-cancel-button:active { background: #343434; }
    #confirm-delete {
      min-height: 28px; padding: 3px 8px; color: #FFFFFF; background: #A93029;
      border: 0; border-radius: 3px;
    }
    #confirm-delete:hover { background: #972B25; }
    #confirm-delete:active { background: #84251F; }
    #confirm-delete:disabled {
      color: #D8C1BF; background: #522522; border: 1px solid #69332F;
      opacity: 1; cursor: default;
    }
    body.vscode-dark #confirm-delete { background: #A1332D; }
    body.vscode-dark #confirm-delete:hover { background: #B43A33; }
    body.vscode-dark #confirm-delete:active { background: #8D2823; }
    body.vscode-dark #confirm-delete:disabled { background: #4E211F; border-color: #66302D; }
    .result-dialog { width: min(680px, calc(100vw - 32px)); }
    .add-record-dialog { width: min(720px, calc(100vw - 32px)); }
    .add-record-fields { display: grid; gap: 14px; }
    .add-record-fields .field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
    .add-record-fields .field-heading { display: flex; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    .add-record-fields label { margin: 0; font-size: 12px; font-weight: 600; }
    .add-record-fields .field-description { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .add-record-fields input, .add-record-fields select, .add-record-fields textarea {
      width: 100%; min-width: 0; min-height: 34px; padding: 6px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font: inherit;
    }
    .add-record-fields textarea { min-height: 34px; max-height: 240px; resize: vertical; }
    .add-record-fields input:focus, .add-record-fields select:focus, .add-record-fields textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .add-record-fields .select-with-custom { display: flex; min-width: 0; gap: 8px; }
    .add-record-fields .select-with-custom select { flex: 1 1 100%; }
    .add-record-fields .select-with-custom.has-custom select { flex: 0 1 auto; max-width: 55%; }
    .add-record-fields .custom-option { flex: 1 1 0; min-width: 0; }
    .add-record-fields .custom-option[hidden] { display: none; }
    .add-record-fields .add-image-area { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
    .add-image-area h3 { margin: 0; font-size: 12px; font-weight: 600; }
    .add-image-area input[type="file"] { display: none; }
    .add-image-area .image-grid { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; }
    .add-image-area .image-card, .add-image-area .image-add { position: relative; width: 72px; height: 72px; flex: 0 0 72px; overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
    .add-image-area .image-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .add-image-area .image-remove { position: absolute; top: 3px; right: 3px; min-width: 24px; min-height: 24px; padding: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .add-image-area .image-add { display: grid; place-items: center; padding: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); border-style: dashed; font-size: 26px; }
    .add-image-area .image-status { min-height: 0; margin: 0; color: var(--vscode-errorForeground); font-size: 12px; }
    .add-image-area .image-status:empty { display: none; }
    .add-source-area { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
    .add-source-area .source-heading { display: grid; gap: 4px; }
    .add-source-area .source-heading span, .add-source-name { color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
    .add-source-area input[type="file"] { display: none; }
    .add-source-area .source-controls { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 8px; }
    .add-source-area .source-select, .add-source-area .source-remove { min-height: 22px; padding: 0 8px; border: 0; border-radius: 3px; font-size: 12px; cursor: pointer; }
    .add-source-area .source-select { color: var(--vscode-button-secondaryForeground); background: rgba(90,90,90,0.14); }
    .add-source-area .source-select:hover { background: rgba(90,90,90,0.20); }
    .add-source-area .source-remove { color: var(--vscode-errorForeground); background: transparent; }
    .add-source-area .source-remove:hover { background: var(--vscode-toolbar-hoverBackground); }
    body.vscode-dark .add-source-area .source-select { background: rgba(255,255,255,0.08); }
    body.vscode-dark .add-source-area .source-select:hover { background: rgba(255,255,255,0.12); }
    .add-source-area .source-status { min-height: 0; margin: 0; color: var(--vscode-errorForeground); font-size: 12px; }
    .add-source-area .source-status:empty { display: none; }
    .add-record-error { margin: 8px 0 0; color: var(--vscode-errorForeground); }
    .add-record-error[hidden] { display: none; }
    #chapter-content-dialog { width: min(840px, calc(100vw - 32px)); }
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
    .chapter-content-list {
      margin: 0; padding: 0 14px; list-style: none;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px;
    }
    .chapter-content-item { display: grid; gap: 9px; padding: 16px 4px 18px; }
    .chapter-content-item + .chapter-content-item { border-top: 1px solid var(--vscode-panel-border); }
    .chapter-content-heading { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: baseline; gap: 12px; }
    .chapter-content-index { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .chapter-content-title { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 15px; font-weight: 600; line-height: 1.45; }
    .chapter-content-text { margin: 0 0 0 84px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    .chapter-content-empty { margin: 0; padding: 20px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    .chapter-content-empty[hidden] { display: none; }
    @media (max-width: 480px) {
      .chapter-content-list { padding: 0 10px; }
      .chapter-content-item { padding: 14px 2px 16px; }
      .chapter-content-heading { grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .chapter-content-text { margin-left: 0; }
    }
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
      .table.has-chapter-content-columns .table-header, .table.has-chapter-content-columns .record-row { grid-template-columns: minmax(0, 1fr) minmax(72px, .9fr) 76px 92px max-content; gap: 5px; }
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
          <div class="table-header" role="row"><span class="record-title-heading">查看生成内容</span><span class="project-column">所属项目</span><span>添加时间</span><span class="generated-time-column">生成时间</span><span class="chapter-content-action-column">操作</span><span class="row-action-column">操作</span></div>
          <div id="record-list" role="rowgroup"></div>
        </div>
        <div id="empty-state" class="empty" role="status" hidden>暂无保存的数据</div>
      </div>
    </section>
    <section id="projects-section" class="project-table" aria-live="polite" hidden>
      <div class="table-header" role="row"><span>项目名称</span><span>项目简介</span><span>创建时间</span><span>操作</span></div>
      <div id="project-list" role="rowgroup"></div>
    </section>
    <dialog id="project-dialog" data-resizable="false" aria-labelledby="project-form-title">
      <form id="project-form" class="project-form">
        <div class="dialog-header">
          <h2 id="project-form-title">创建项目</h2>
          <button class="dialog-close" id="close-project-dialog" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="dialog-body project-dialog-body">
          <div>
            <label for="project-name">项目名称</label>
            <input id="project-name" name="name" type="text" maxlength="120" required autocomplete="off">
          </div>
          <div>
            <label for="project-description">项目简介</label>
            <textarea id="project-description" name="description" rows="1"></textarea>
          </div>
          <p id="project-form-error" class="project-form-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="cancel-project-dialog" class="dialog-cancel-button" type="button">取消</button>
            <button id="save-project" class="filter-button dialog-save-button" type="submit">创建</button>
          </div>
        </div>
      </form>
    </dialog>
    <dialog id="add-record-dialog" class="add-record-dialog" data-resizable="true" aria-labelledby="add-record-dialog-title">
      <form id="add-record-form">
        <div class="dialog-header">
          <h2 id="add-record-dialog-title">添加任务</h2>
          <button class="dialog-close" id="close-add-record" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="dialog-body">
          <div id="add-record-fields" class="add-record-fields"></div>
          <p id="add-record-error" class="add-record-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="cancel-add-record" class="dialog-cancel-button" type="button">取消</button>
            <button id="add-record-save" class="filter-button dialog-save-button" type="submit">保存</button>
          </div>
        </div>
      </form>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
    <dialog id="project-warning-dialog" data-resizable="false" aria-labelledby="project-warning-title">
      <div class="dialog-header">
        <h2 id="project-warning-title">删除项目</h2>
        <button class="dialog-close" id="close-project-warning" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="dialog-body">
        <p class="delete-warning">此操作不可撤销。删除项目会同时删除该项目下的所有任务数据及已生成内容。</p>
        <p id="project-warning-name"></p>
        <div class="dialog-actions">
          <button id="cancel-project-warning" class="dialog-cancel-button" type="button">取消</button>
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
            <button id="cancel-delete" class="dialog-cancel-button" type="button">取消</button>
            <button id="confirm-delete" type="submit" disabled>删除</button>
          </div>
        </div>
      </form>
      <span class="dialog-resize-handle dialog-resize-horizontal" data-resize="horizontal" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-vertical" data-resize="vertical" aria-hidden="true"></span>
      <span class="dialog-resize-handle dialog-resize-corner" data-resize="both" aria-hidden="true"></span>
    </dialog>
    <dialog id="run-confirm-dialog" data-resizable="false" aria-labelledby="run-confirm-title">
      <form id="run-confirm-form">
        <div class="dialog-header">
          <h2 id="run-confirm-title">确认运行生成</h2>
          <button class="dialog-close" id="close-run-confirm" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="dialog-body">
          <p id="run-confirm-prompt"></p>
          <div id="run-confirm-code-field" hidden>
            <label for="run-confirm-code">输入上方显示的四位验证码</label>
            <input id="run-confirm-code" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" spellcheck="false" aria-describedby="run-confirm-error">
          </div>
          <p id="run-confirm-error" class="delete-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="cancel-run-confirm" class="dialog-cancel-button" type="button">取消</button>
            <button id="confirm-run" class="filter-button dialog-save-button" type="submit">确认生成</button>
          </div>
        </div>
      </form>
    </dialog>
    <dialog id="chapter-content-dialog" class="result-dialog" data-resizable="true" aria-labelledby="chapter-content-dialog-title">
      <div class="dialog-header">
        <h2 id="chapter-content-dialog-title">查看章节</h2>
        <button class="dialog-close" id="close-chapter-content" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="dialog-body">
        <ol id="chapter-content-list" class="chapter-content-list" aria-label="章节内容列表"></ol>
        <p id="chapter-content-empty" class="chapter-content-empty" role="status" hidden>暂无已保存的章节内容</p>
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
          <button id="edit-result" class="dialog-save-button" type="button" disabled>保存</button>
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
    const chapterContentWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.supportsChapterContent === true)
      .map((workflow) => workflow.toolName))};
    const screenplayWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.toolName === SCREENPLAY_WORKFLOW_NAME)
      .map((workflow) => workflow.toolName))};
    const contentTaskNameWorkflowIds = ${JSON.stringify(workflows
      .filter((workflow) => workflow.toolName === SCREENPLAY_WORKFLOW_NAME || workflow.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME)
      .map((workflow) => workflow.toolName))};
    const workflowTitles = ${JSON.stringify(Object.fromEntries(workflows.map((workflow) => [workflow.toolName, workflow.title])))};
    const recordList = document.getElementById('record-list');
    const recordsTable = document.getElementById('records-table');
    const recordTitleHeading = recordsTable.querySelector('.record-title-heading');
    const emptyState = document.getElementById('empty-state');
    const projectList = document.getElementById('project-list');
    const recordsSection = document.getElementById('records-section');
    const projectsSection = document.getElementById('projects-section');
    const projectDialog = document.getElementById('project-dialog');
    const projectForm = document.getElementById('project-form');
    const projectNameInput = document.getElementById('project-name');
    const projectDescriptionInput = document.getElementById('project-description');
    const projectFormError = document.getElementById('project-form-error');
    const projectFormTitle = document.getElementById('project-form-title');
    const saveProjectButton = document.getElementById('save-project');
    const projectFilter = document.getElementById('project-filter');
    const projectFilterTrigger = document.getElementById('project-filter-trigger');
    const projectFilterLabel = document.getElementById('project-filter-label');
    const projectFilterMenu = document.getElementById('project-filter-menu');
    const deleteDialog = document.getElementById('delete-dialog');
    const addRecordDialog = document.getElementById('add-record-dialog');
    const addRecordForm = document.getElementById('add-record-form');
    const addRecordTitle = document.getElementById('add-record-dialog-title');
    const addRecordFields = document.getElementById('add-record-fields');
    const addRecordError = document.getElementById('add-record-error');
    const addRecordSaveButton = document.getElementById('add-record-save');
    const projectWarningDialog = document.getElementById('project-warning-dialog');
    const projectWarningName = document.getElementById('project-warning-name');
    const deleteForm = document.getElementById('delete-form');
    const deletePrompt = document.getElementById('delete-prompt');
    const deleteTitle = document.getElementById('delete-title');
    const deleteError = document.getElementById('delete-error');
    const confirmDelete = document.getElementById('confirm-delete');
    const runConfirmDialog = document.getElementById('run-confirm-dialog');
    const runConfirmForm = document.getElementById('run-confirm-form');
    const runConfirmTitle = document.getElementById('run-confirm-title');
    const runConfirmPrompt = document.getElementById('run-confirm-prompt');
    const runConfirmCodeField = document.getElementById('run-confirm-code-field');
    const runConfirmCode = document.getElementById('run-confirm-code');
    const runConfirmError = document.getElementById('run-confirm-error');
    const confirmRunButton = document.getElementById('confirm-run');
    const resultDialog = document.getElementById('result-dialog');
    const chapterContentDialog = document.getElementById('chapter-content-dialog');
    const chapterContentDialogTitle = document.getElementById('chapter-content-dialog-title');
    const chapterContentList = document.getElementById('chapter-content-list');
    const chapterContentEmpty = document.getElementById('chapter-content-empty');
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
    let pendingRun;
    let viewingResultRecordId;
    let viewingChapterRecordId;
    let selectedCategoryId;
    let selectedProjectFilter = 'all';
    let projectFilterItems = [];
    let currentViewMode = 'records';
    let editingProjectId;
    let projects = [];
    let viewingResultType;
    let isResultLoaded = false;
    let addRecordCategoryId;
    let addRecordMode = 'add';
    let editingRecordId;
    let addImageAttachments = [];
    let addRecordSourceFileReadPending = false;
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
      if (chapterContentWorkflowIds.includes(workflowId) || contentWorkflowIds.includes(workflowId)) return '查看内容';
      return '查看' + workflowTitles[workflowId] + '提示词';
    }

    function openAddRecordDialog(message) {
      if (typeof message.categoryId !== 'string' || typeof message.formFields !== 'string') return;
      if (addRecordDialog.open) addRecordDialog.close();
      addRecordMode = message.mode === 'edit' ? 'edit' : 'add';
      editingRecordId = addRecordMode === 'edit' ? message.recordId : undefined;
      addRecordCategoryId = message.categoryId;
      addRecordTitle.textContent = message.title;
      addRecordFields.innerHTML = message.formFields;
      const sourceTaskSelect = addRecordFields.querySelector('[data-project-content-task]');
      const projectSelect = document.getElementById('add-record-project');
      if (sourceTaskSelect && projectSelect) {
        const updateSourceTasks = () => {
          Array.from(sourceTaskSelect.options).forEach((option) => {
            if (option.dataset.projectId) option.hidden = option.dataset.projectId !== projectSelect.value;
          });
          if (sourceTaskSelect.selectedOptions[0]?.dataset.projectId !== projectSelect.value) {
            sourceTaskSelect.value = '';
          }
        };
        projectSelect.addEventListener('change', updateSourceTasks);
        updateSourceTasks();
      }
      addRecordError.textContent = '';
      addRecordError.hidden = true;
      addRecordSaveButton.disabled = false;
      addImageAttachments = [];
      addRecordSourceFileReadPending = false;
      const imageValue = document.getElementById('add-image-value');
      if (imageValue) addImageAttachments = JSON.parse(imageValue.value);

      addRecordFields.querySelectorAll('[data-custom-input]').forEach((select) => {
        const customInput = document.getElementById(select.dataset.customInput);
        const wrapper = select.closest('.select-with-custom');
        const updateCustomInput = () => {
          const isCustom = select.value === '__custom__';
          customInput.hidden = !isCustom;
          customInput.disabled = !isCustom;
          customInput.required = isCustom;
          wrapper.classList.toggle('has-custom', isCustom);
        };
        select.addEventListener('change', updateCustomInput);
        updateCustomInput();
      });
      addRecordFields.querySelectorAll('textarea').forEach((textarea) => {
        const resize = () => {
          textarea.style.height = 'auto';
          textarea.style.height = Math.max(34, Math.min(textarea.scrollHeight, 240)) + 'px';
        };
        textarea.addEventListener('input', resize);
        if (textarea.value.trim()) resize();
        else textarea.style.height = '34px';
      });

      const imageInput = document.getElementById('add-image-file-input');
      if (imageInput) {
        imageInput.addEventListener('change', () => {
          void addRecordImageFiles(imageInput.files);
          imageInput.value = '';
        });
        renderAddRecordImages();
      }
      const sourceFileInput = document.getElementById('add-source-file-input');
      if (sourceFileInput) {
        const sourceValue = document.getElementById('add-source-value');
        const sourceName = document.getElementById('add-source-name');
        const sourceStatus = document.getElementById('add-source-status');
        const removeSourceButton = document.getElementById('remove-add-source');
        function formatSourceFileSize(sizeBytes) {
          return sizeBytes < 1024 * 1024
            ? (sizeBytes / 1024).toFixed(1) + ' KB'
            : (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB';
        }
        const renderSourceFile = () => {
          const source = sourceValue.value ? JSON.parse(sourceValue.value) : undefined;
          sourceName.textContent = source
            ? source.name + ' (' + formatSourceFileSize(new TextEncoder().encode(source.content).byteLength) + ')'
            : '未选择原作文件';
          removeSourceButton.hidden = !source;
        };
        document.getElementById('select-add-source').addEventListener('click', () => sourceFileInput.click());
        sourceFileInput.addEventListener('change', async () => {
          const file = sourceFileInput.files[0];
          sourceFileInput.value = '';
          if (!file) return;
          addRecordSourceFileReadPending = true;
          addRecordSaveButton.disabled = true;
          try {
            if (!/\.(?:txt|md)$/i.test(file.name)) {
              throw new Error('原作文件仅支持 TXT 或 Markdown 格式。');
            }
            if (file.size === 0 || file.size > 10 * 1024 * 1024) {
              throw new Error('原作文件不能为空或超过 10 MiB。');
            }
            let content;
            try {
              content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            } catch {
              throw new Error('原作文件必须使用 UTF-8 编码。');
            }
            if (!content.trim()) throw new Error('原作文件内容不能为空。');
            sourceValue.value = JSON.stringify({ name: file.name, content });
            sourceStatus.textContent = '';
            renderSourceFile();
          } catch (error) {
            sourceStatus.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            addRecordSourceFileReadPending = false;
            addRecordSaveButton.disabled = false;
          }
        });
        removeSourceButton.addEventListener('click', () => {
          sourceValue.value = '';
          sourceStatus.textContent = '';
          renderSourceFile();
        });
        renderSourceFile();
      }
      addRecordDialog.showModal();
      addRecordFields.querySelector('input, select, textarea, button')?.focus();
    }

    function closeAddRecordDialog() {
      if (addRecordDialog.open) addRecordDialog.close();
      addRecordCategoryId = undefined;
      addRecordMode = 'add';
      editingRecordId = undefined;
      addImageAttachments = [];
      addRecordSourceFileReadPending = false;
      addRecordFields.replaceChildren();
      addRecordError.textContent = '';
      addRecordError.hidden = true;
      addRecordSaveButton.disabled = false;
    }

    function renderAddRecordImages() {
      const imageGrid = document.getElementById('add-image-grid');
      const imageInput = document.getElementById('add-image-file-input');
      const imageValue = document.getElementById('add-image-value');
      if (!imageGrid || !imageInput || !imageValue) return;
      imageGrid.replaceChildren();
      addImageAttachments.forEach((attachment, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        const image = document.createElement('img');
        image.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
        image.alt = '图片 ' + (index + 1);
        const remove = makeButton('×', 'image-remove', '移除第 ' + (index + 1) + ' 张图片', () => {
          addImageAttachments.splice(index, 1);
          renderAddRecordImages();
        });
        card.append(image, remove);
        imageGrid.append(card);
      });
      const add = makeButton('+', 'image-add', '添加图片', () => imageInput.click());
      imageGrid.append(add);
      imageValue.value = JSON.stringify(addImageAttachments);
    }

    async function readAddRecordImage(file) {
      if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
        throw new Error('仅支持 PNG 和 JPEG 图片。');
      }
      if (file.size === 0 || file.size > 10 * 1024 * 1024) {
        throw new Error('单张图片不能为空或超过 10 MB。');
      }
      const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const isPng = file.type === 'image/png' &&
        signature.length === 8 && signature[0] === 137 && signature[1] === 80 && signature[2] === 78 &&
        signature[3] === 71 && signature[4] === 13 && signature[5] === 10 && signature[6] === 26 && signature[7] === 10;
      const isJpeg = file.type === 'image/jpeg' && signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
      if (!isPng && !isJpeg) throw new Error('图片内容与声明的 PNG 或 JPEG 格式不匹配。');
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error('读取图片失败，请重新选择。'));
            return;
          }
          const match = /^data:(image\\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(reader.result);
          if (!match) {
            reject(new Error('图片内容不是有效的 PNG 或 JPEG 数据。'));
            return;
          }
          resolve({ mimeType: match[1], data: match[2] });
        };
        reader.readAsDataURL(file);
      });
    }

    async function addRecordImageFiles(fileList) {
      const imageStatus = document.getElementById('add-image-status');
      if (!imageStatus) return;
      try {
        const images = await Promise.all(Array.from(fileList).map(readAddRecordImage));
        const knownData = new Set(addImageAttachments.map((image) => image.data));
        const uniqueImages = images.filter((image) => {
          if (knownData.has(image.data)) return false;
          knownData.add(image.data);
          return true;
        });
        if (addImageAttachments.length + uniqueImages.length > 20) {
          throw new Error('图片最多添加 20 张。');
        }
        const totalBytes = [...addImageAttachments, ...uniqueImages]
          .reduce((total, image) => total + Math.ceil(image.data.length * 3 / 4), 0);
        if (totalBytes > 25 * 1024 * 1024) throw new Error('图片附件总大小不能超过 25 MB。');
        addImageAttachments.push(...uniqueImages);
        imageStatus.textContent = '';
        renderAddRecordImages();
      } catch (error) {
        imageStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function sendAddRecordValues() {
      if (addRecordSourceFileReadPending) return;
      if (!addRecordCategoryId || !addRecordForm.reportValidity()) return;
      const formData = new FormData(addRecordForm);
      const projectId = formData.get('projectId');
      const values = Object.fromEntries(
        [...formData.entries()].filter(([name]) => name !== 'projectId' && !name.endsWith('__custom'))
      );
      addRecordFields.querySelectorAll('[data-custom-input]').forEach((select) => {
        if (select.value === '__custom__') {
          const customInput = document.getElementById(select.dataset.customInput);
          values[select.name] = customInput.value;
        }
      });
      addRecordError.hidden = true;
      addRecordSaveButton.disabled = true;
      vscode.postMessage({
        command: addRecordMode === 'edit' ? 'update-record' : 'save-add-record',
        categoryId: addRecordCategoryId,
        ...(addRecordMode === 'edit' ? { recordId: editingRecordId } : {}),
        projectId,
        values
      });
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
      const taskName = record.taskName;
      pendingDelete = { kind: 'record', id: record.id, title: taskName };
      showDeleteNameDialog('任务', taskName);
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

    function openRunConfirmation(record) {
      const requiresCode = Boolean(record.generatedAt);
      const values = new Uint32Array(1);
      if (requiresCode) window.crypto.getRandomValues(values);
      pendingRun = {
        recordId: record.id,
        confirmationCode: requiresCode ? String(values[0] % 10000).padStart(4, '0') : undefined
      };
      runConfirmTitle.textContent = requiresCode ? '确认重新运行生成' : '确认运行生成';
      runConfirmPrompt.replaceChildren();
      if (requiresCode) {
        const highlightedCode = document.createElement('span');
        highlightedCode.className = 'delete-title-highlight';
        highlightedCode.textContent = pendingRun.confirmationCode;
        runConfirmPrompt.append(
          document.createTextNode('此任务已有生成数据，请在下方输入验证码： '),
          highlightedCode,
          document.createTextNode(' （四位数字）确定重新运行生成！')
        );
      } else {
        runConfirmPrompt.textContent = '确定运行生成吗？将使用此任务已保存的参数启动创作流程。';
      }
      runConfirmCodeField.hidden = !requiresCode;
      runConfirmCode.value = '';
      runConfirmError.textContent = '';
      runConfirmError.hidden = true;
      confirmRunButton.textContent = requiresCode ? '重新运行生成' : '确认生成';
      confirmRunButton.disabled = requiresCode;
      runConfirmDialog.showModal();
      if (requiresCode) runConfirmCode.focus();
      else confirmRunButton.focus();
    }

    function closeRunConfirmation() {
      if (runConfirmDialog.open) runConfirmDialog.close();
      pendingRun = undefined;
      runConfirmCode.value = '';
      runConfirmError.textContent = '';
      runConfirmError.hidden = true;
      confirmRunButton.disabled = false;
    }

    function closeDeleteDialog() {
      deleteDialog.close();
      pendingDelete = undefined;
      deleteTitle.value = '';
      deleteError.hidden = true;
      confirmDelete.disabled = true;
    }

    function openResultDialog(record) {
      const taskName = record.taskName;
      const isBilingualContent = bilingualContentWorkflowIds.includes(selectedCategoryId);
      viewingResultType = isBilingualContent
        ? 'bilingual-content'
        : contentWorkflowIds.includes(selectedCategoryId) ? 'content' : 'prompt';
      const isContent = viewingResultType !== 'prompt';
      resultDialogTitle.textContent = getResultActionLabel(selectedCategoryId) + '：' + taskName;
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

    function openChapterContentDialog(record) {
      viewingChapterRecordId = record.id;
      chapterContentDialogTitle.textContent = '查看章节：' + record.taskName;
      chapterContentList.replaceChildren();
      chapterContentEmpty.hidden = true;
      chapterContentDialog.showModal();
      document.getElementById('close-chapter-content').focus();
      vscode.postMessage({ command: 'view-chapters', recordId: record.id });
    }

    function closeChapterContentDialog() {
      chapterContentDialog.close();
      viewingChapterRecordId = undefined;
    }

    function renderChapterContents(chapters) {
      chapterContentList.replaceChildren();
      chapterContentEmpty.hidden = chapters.length > 0;
      for (const chapter of chapters) {
        const item = document.createElement('li');
        item.className = 'chapter-content-item';
        const heading = document.createElement('div');
        heading.className = 'chapter-content-heading';
        const number = document.createElement('span');
        number.className = 'chapter-content-index';
        number.textContent = '第 ' + chapter.chapterNumber + ' 章';
        const title = document.createElement('h3');
        title.className = 'chapter-content-title';
        title.textContent = chapter.title;
        const content = document.createElement('p');
        content.className = 'chapter-content-text';
        content.textContent = chapter.content;
        heading.append(number, title);
        item.append(heading, content);
        chapterContentList.append(item);
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

    function openProjectDialog(message) {
      editingProjectId = message.mode === 'edit' && typeof message.projectId === 'string'
        ? message.projectId
        : undefined;
      projectFormTitle.textContent = editingProjectId ? '编辑项目' : '创建项目';
      saveProjectButton.textContent = editingProjectId ? '保存' : '创建';
      projectNameInput.value = message.projectName ?? '';
      projectDescriptionInput.value = message.projectDescription ?? '';
      projectFormError.textContent = '';
      projectFormError.hidden = true;
      saveProjectButton.disabled = false;
      projectDialog.showModal();
      projectNameInput.focus();
    }

    function closeProjectDialog() {
      if (projectDialog.open) projectDialog.close();
      editingProjectId = undefined;
      projectFormError.textContent = '';
      projectFormError.hidden = true;
      saveProjectButton.disabled = false;
    }

    function renderState(state) {
      selectedCategoryId = state.categoryId;
      currentViewMode = state.viewMode;
      recordTitleHeading.textContent = contentTaskNameWorkflowIds.includes(state.categoryId)
        ? '所属内容任务名称'
        : '查看生成内容';
      const hasChapterContentColumns = chapterContentWorkflowIds.includes(state.categoryId);
      recordsTable.classList.toggle('has-chapter-content-columns', hasChapterContentColumns);
      recordsTable.classList.toggle('has-project-columns', state.categoryId !== undefined);
      projects = state.projects;
      recordsSection.hidden = state.viewMode !== 'records';
      projectsSection.hidden = state.viewMode !== 'projects';
      renderProjectFilter([
        { value: 'all', label: '所有内容', isScopeOption: true },
        ...projects.map((project) => ({ value: project.id, label: project.name }))
      ], state.projectFilter);
      if (state.viewMode === 'projects') {
        emptyState.hidden = true;
        renderWorkProjects(projects);
        return;
      }
      recordList.replaceChildren();
      if (!state.records.length) {
        emptyState.hidden = false;
        return;
      }
      emptyState.hidden = true;

      for (const record of state.records) {
        const row = document.createElement('div');
        row.className = 'record-row';
        row.setAttribute('role', 'row');
        const titleCell = document.createElement('span');
        titleCell.className = 'record-cell record-title';
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'record-title-button';
        title.textContent = record.taskName;
        title.title = title.textContent;
        title.setAttribute('aria-label', '查看' + title.textContent + '的生成内容');
        title.addEventListener('click', () => {
          if (chapterContentWorkflowIds.includes(selectedCategoryId)) {
            openChapterContentDialog(record);
          } else {
            openResultDialog(record);
          }
        });
        titleCell.append(title);
        const projectName = document.createElement('span');
        projectName.className = 'record-cell project-column';
        projectName.textContent = record.projectId === '0' ? '-' : record.projectName || '-';
        projectName.title = projectName.textContent;
        const runRecord = makeButton('运行生成', 'edit-button', '运行生成' + title.textContent, () => {
          openRunConfirmation(record);
        });
        const editRecord = makeButton('编辑', 'edit-button', '编辑' + title.textContent, () => {
          vscode.postMessage({ command: 'select-record', recordId: record.id });
        });
        const remove = makeButton('删除', 'delete-button', '删除' + title.textContent, () => {
          openDeleteDialog(record);
        });
        if (hasChapterContentColumns) {
          const viewContentCell = document.createElement('span');
          viewContentCell.className = 'record-cell chapter-content-action-column';
          const recordActions = document.createElement('div');
          recordActions.className = 'record-actions';
          recordActions.append(runRecord, editRecord, remove);
          viewContentCell.append(recordActions);
          row.append(titleCell, projectName, makeTime(record.createdAt), makeGeneratedTime(record.generatedAt), viewContentCell);
        } else {
          const actionCell = document.createElement('span');
          actionCell.className = 'record-cell row-action-column';
          const actions = document.createElement('div');
          actions.className = 'record-actions';
          actions.append(runRecord, editRecord, remove);
          actionCell.append(actions);
          row.append(titleCell, projectName, makeTime(record.createdAt), makeGeneratedTime(record.generatedAt), actionCell);
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
      projectFormError.hidden = true;
      saveProjectButton.disabled = true;
      vscode.postMessage({
        command: editingProjectId ? 'update-project' : 'submit-project',
        ...(editingProjectId ? { projectId: editingProjectId } : {}),
        projectName: projectNameInput.value,
        projectDescription: projectDescriptionInput.value
      });
    });
    document.getElementById('cancel-project-dialog').addEventListener('click', closeProjectDialog);
    document.getElementById('close-project-dialog').addEventListener('click', closeProjectDialog);
    projectDialog.addEventListener('close', () => {
      editingProjectId = undefined;
    });
    addRecordForm.addEventListener('submit', (event) => {
      event.preventDefault();
      sendAddRecordValues();
    });
    document.getElementById('cancel-add-record').addEventListener('click', closeAddRecordDialog);
    document.getElementById('close-add-record').addEventListener('click', closeAddRecordDialog);
    addRecordDialog.addEventListener('close', () => {
      addRecordCategoryId = undefined;
      addRecordMode = 'add';
      editingRecordId = undefined;
      addImageAttachments = [];
    });
    window.addEventListener('paste', (event) => {
      if (!addRecordDialog.open) return;
      const imageArea = addRecordFields.querySelector('.add-image-area');
      if (!imageArea || (!imageArea.matches(':hover') && !imageArea.contains(document.activeElement))) return;
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file) => file !== null);
      if (imageFiles.length > 0) {
        event.preventDefault();
        void addRecordImageFiles(imageFiles);
      }
    });

    deleteTitle.addEventListener('input', () => {
      confirmDelete.disabled = !pendingDelete || deleteTitle.value !== pendingDelete.title;
      deleteError.hidden = true;
    });

    deleteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!pendingDelete || deleteTitle.value !== pendingDelete.title) {
        deleteError.textContent = '输入的名称与任务名称不一致。';
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

    runConfirmCode.addEventListener('input', () => {
      confirmRunButton.disabled = !pendingRun || pendingRun.confirmationCode !== runConfirmCode.value;
      runConfirmError.hidden = true;
    });
    runConfirmForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!pendingRun) return;
      if (pendingRun.confirmationCode && runConfirmCode.value !== pendingRun.confirmationCode) {
        runConfirmError.textContent = '验证码不正确，请输入本次操作显示的四位数字验证码。';
        runConfirmError.hidden = false;
        confirmRunButton.disabled = true;
        return;
      }

      const recordId = pendingRun.recordId;
      pendingRun = undefined;
      runConfirmDialog.close();
      vscode.postMessage({ command: 'run-record', recordId });
    });

    document.getElementById('cancel-delete').addEventListener('click', closeDeleteDialog);
    document.getElementById('close-delete').addEventListener('click', closeDeleteDialog);
    document.getElementById('cancel-run-confirm').addEventListener('click', closeRunConfirmation);
    document.getElementById('close-run-confirm').addEventListener('click', closeRunConfirmation);
    runConfirmDialog.addEventListener('close', () => {
      pendingRun = undefined;
      runConfirmCode.value = '';
      runConfirmError.textContent = '';
      runConfirmError.hidden = true;
      confirmRunButton.disabled = false;
    });
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
    document.getElementById('close-chapter-content').addEventListener('click', closeChapterContentDialog);
    chapterContentDialog.addEventListener('cancel', () => {
      viewingChapterRecordId = undefined;
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
      if (event.data.command === 'open-add-record-dialog') openAddRecordDialog(event.data);
      if (event.data.command === 'record-updated') closeAddRecordDialog();
      if (event.data.command === 'update-record-error') {
        addRecordSaveButton.disabled = false;
        addRecordError.textContent = event.data.text;
        addRecordError.hidden = false;
      }
      if (event.data.command === 'add-record-error') {
        addRecordSaveButton.disabled = false;
        addRecordError.textContent = event.data.text;
        addRecordError.hidden = false;
      }
      if (event.data.command === 'add-record-saved') closeAddRecordDialog();
      if (event.data.command === 'open-project-dialog') openProjectDialog(event.data);
      if (event.data.command === 'project-saved') closeProjectDialog();
      if (event.data.command === 'project-create-error') {
        saveProjectButton.disabled = false;
        projectFormError.textContent = event.data.text;
        projectFormError.hidden = false;
      }
      if (event.data.command === 'generated-chapters' && event.data.recordId === viewingChapterRecordId) {
        renderChapterContents(event.data.chapters);
      }
      if (event.data.command === 'delete-success') closeDeleteDialog();
      if (event.data.command === 'generated-result' && event.data.recordId === viewingResultRecordId) {
        viewingResultType = event.data.resultType;
        const isContent = viewingResultType === 'content';
        const isBilingualContent = viewingResultType === 'bilingual-content';
        contentResultField.hidden = !isContent;
        promptResultFields.hidden = isContent && !isBilingualContent;
        resultDialogTitle.textContent = getResultActionLabel(selectedCategoryId) + '：' + event.data.taskName;
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
